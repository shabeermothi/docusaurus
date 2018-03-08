/**

 * Copyright (c) 2017-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

function execute(port) {
  const extractTranslations = require('../write-translations.js');

  const env = require('./env.js');
  const translation = require('./translation.js');
  const express = require('express');
  const React = require('react');
  const request = require('request');
  const renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup;
  const fs = require('fs-extra');
  const os = require('os');
  const path = require('path');
  const color = require('color');
  const toSlug = require('../core/toSlug.js');
  const mkdirp = require('mkdirp');
  const glob = require('glob');
  const chalk = require('chalk');
  const translate = require('./translate.js');

  const feed = require('./feed.js');
  const sitemap = require('./sitemap.js');
  // const sitemap = require("sitemap");

  const CWD = process.cwd();

  // remove a module and child modules from require cache, so server does not have
  // to be restarted
  function removeModuleAndChildrenFromCache(moduleName) {
    let mod = require.resolve(moduleName);
    if (mod && (mod = require.cache[mod])) {
      mod.children.forEach(child => {
        delete require.cache[child.id];
        removeModulePathFromCache(mod.id);
      });
      delete require.cache[mod.id];
      removeModulePathFromCache(mod.id);
    }
  }

  function removeModulePathFromCache(moduleName) {
    Object.keys(module.constructor._pathCache).forEach(function(cacheKey) {
      if (cacheKey.indexOf(moduleName) > 0) {
        delete module.constructor._pathCache[cacheKey];
      }
    });
  }

  /****************************************************************************/

  let readMetadata = require('./readMetadata.js');
  let Metadata;
  let MetadataBlog;
  let siteConfig;

  function reloadMetadata() {
    removeModuleAndChildrenFromCache('./readMetadata.js');
    readMetadata.generateMetadataDocs();
    removeModuleAndChildrenFromCache('../core/metadata.js');
    Metadata = require('../core/metadata.js');
  }

  function reloadMetadataBlog() {
    if (fs.existsSync(__dirname + '/../core/MetadataBlog.js')) {
      removeModuleAndChildrenFromCache('../core/MetadataBlog.js');
      fs.removeSync(__dirname + '/../core/MetadataBlog.js');
    }
    readMetadata.generateMetadataBlog();
    MetadataBlog = require('../core/MetadataBlog.js');
  }

  function reloadSiteConfig() {
    removeModuleAndChildrenFromCache(CWD + '/siteConfig.js');
    siteConfig = require(CWD + '/siteConfig.js');

    if (siteConfig.highlight && siteConfig.highlight.hljs) {
      siteConfig.highlight.hljs(require('highlight.js'));
    }
  }

  /****************************************************************************/

  const TABLE_OF_CONTENTS_TOKEN = '<AUTOGENERATED_TABLE_OF_CONTENTS>';

  const insertTableOfContents = rawContent => {
    const regexp = /\n###\s+(`.*`.*)\n/g;
    let match;
    const headers = [];
    while ((match = regexp.exec(rawContent))) {
      headers.push(match[1]);
    }

    const tableOfContents = headers
      .map(header => `  - [${header}](#${toSlug(header)})`)
      .join('\n');

    return rawContent.replace(TABLE_OF_CONTENTS_TOKEN, tableOfContents);
  };

  /****************************************************************************/

  function isSeparateCss(file) {
    if (!siteConfig.separateCss) {
      return false;
    }
    for (let i = 0; i < siteConfig.separateCss.length; i++) {
      if (file.includes(siteConfig.separateCss[i])) {
        return true;
      }
    }
    return false;
  }

  /****************************************************************************/

  reloadMetadata();
  reloadMetadataBlog();
  extractTranslations();
  reloadSiteConfig();

  // handle all requests for document pages
  const app = express();

  app.get(/docs\/.*html$/, (req, res, next) => {
    let url = req.path.toString().replace(siteConfig.baseUrl, '');

    // links is a map from a permalink to an id for each document
    let links = {};
    Object.keys(Metadata).forEach(id => {
      const metadata = Metadata[id];
      links[metadata.permalink] = id;
    });

    // mdToHtml is a map from a markdown file name to its html link, used to
    // change relative markdown links that work on GitHub into actual site links
    const mdToHtml = {};
    Object.keys(Metadata).forEach(id => {
      const metadata = Metadata[id];
      if (metadata.language !== 'en' || metadata.original_id) {
        return;
      }
      let htmlLink =
        siteConfig.baseUrl + metadata.permalink.replace('/next/', '/');
      if (htmlLink.includes('/docs/en/')) {
        htmlLink = htmlLink.replace('/docs/en/', '/docs/en/VERSION/');
      } else {
        htmlLink = htmlLink.replace('/docs/', '/docs/VERSION/');
      }
      mdToHtml[metadata.source] = htmlLink;
    });

    const metadata = Metadata[links[url]];
    if (!metadata) {
      next();
      return;
    }
    const language = metadata.language;

    // determine what file to use according to its id
    let file;
    if (metadata.original_id) {
      if (env.translation.enabled && metadata.language !== 'en') {
        file =
          CWD + '/translated_docs/' + metadata.language + '/' + metadata.source;
      } else {
        file = CWD + '/versioned_docs/' + metadata.source;
      }
    } else {
      if (!env.translation.enabled || metadata.language === 'en') {
        file =
          CWD + '/../' + readMetadata.getDocsPath() + '/' + metadata.source;
      } else {
        file =
          CWD + '/translated_docs/' + metadata.language + '/' + metadata.source;
      }
    }

    if (!fs.existsSync(file)) {
      next();
      return;
    }

    let rawContent = readMetadata.extractMetadata(fs.readFileSync(file, 'utf8'))
      .rawContent;

    // generate table of contents if appropriate
    if (rawContent && rawContent.indexOf(TABLE_OF_CONTENTS_TOKEN) !== -1) {
      rawContent = insertTableOfContents(rawContent);
    }

    let latestVersion = env.versioning.latestVersion;

    // replace any links to markdown files to their website html links
    Object.keys(mdToHtml).forEach(function(key, index) {
      let link = mdToHtml[key];
      link = link.replace('/en/', '/' + language + '/');
      link = link.replace(
        '/VERSION/',
        metadata.version && metadata.version !== latestVersion
          ? '/' + metadata.version + '/'
          : '/'
      );
      // replace relative links without "./"
      rawContent = rawContent.replace(
        new RegExp('\\]\\(' + key, 'g'),
        '](' + link
      );
      // replace relative links with "./"
      rawContent = rawContent.replace(
        new RegExp('\\]\\(\\./' + key, 'g'),
        '](' + link
      );
    });

    // replace any relative links to static assets to absolute links
    rawContent = rawContent.replace(
      /\]\(assets\//g,
      '](' + siteConfig.baseUrl + 'docs/assets/'
    );

    removeModuleAndChildrenFromCache('../core/DocsLayout.js');
    const DocsLayout = require('../core/DocsLayout.js');

    let Doc;
    if (
      metadata.layout &&
      siteConfig.layouts &&
      siteConfig.layouts[metadata.layout]
    ) {
      Doc = siteConfig.layouts[metadata.layout]({
        React,
        MarkdownBlock: require('../core/MarkdownBlock.js'),
      });
    }

    const docComp = (
      <DocsLayout
        metadata={metadata}
        language={language}
        config={siteConfig}
        Doc={Doc}>
        {rawContent}
      </DocsLayout>
    );

    res.send(renderToStaticMarkup(docComp));
  });

  app.get('/sitemap.xml', function(req, res) {
    res.set('Content-Type', 'application/xml');

    sitemap(xml => {
      res.send(xml);
    });
  });

  app.get(/blog\/.*xml$/, (req, res) => {
    res.set('Content-Type', 'application/rss+xml');
    let parts = req.path.toString().split('blog/');
    if (parts[1].toLowerCase() == 'atom.xml') {
      res.send(feed('atom'));
      return;
    }
    res.send(feed('rss'));
  });

  // handle all requests for blog pages and posts
  app.get(/blog\/.*html$/, (req, res) => {
    // generate all of the blog pages
    removeModuleAndChildrenFromCache('../core/BlogPageLayout.js');
    const BlogPageLayout = require('../core/BlogPageLayout.js');
    const blogPages = {};
    // make blog pages with 10 posts per page
    const perPage = 10;
    for (
      let page = 0;
      page < Math.ceil(MetadataBlog.length / perPage);
      page++
    ) {
      let language = 'en';
      const metadata = {page: page, perPage: perPage};
      const blogPageComp = (
        <BlogPageLayout
          metadata={metadata}
          language={language}
          config={siteConfig}
        />
      );
      const str = renderToStaticMarkup(blogPageComp);

      let path = (page > 0 ? 'page' + (page + 1) : '') + '/index.html';
      blogPages[path] = str;
    }

    let parts = req.path.toString().split('blog/');
    // send corresponding blog page if appropriate
    if (parts[1] === 'index.html') {
      res.send(blogPages['/index.html']);
    } else if (parts[1].endsWith('/index.html')) {
      res.send(blogPages[parts[1]]);
    } else if (parts[1].match(/page([0-9]+)/)) {
      if (parts[1].endsWith('/')) {
        res.send(blogPages[parts[1] + 'index.html']);
      } else {
        res.send(blogPages[parts[1] + '/index.html']);
      }
    } else {
      // else send corresponding blog post
      let file = parts[1];
      file = file.replace(/\.html$/, '.md');
      file = file.replace(new RegExp('/', 'g'), '-');
      file = CWD + '/blog/' + file;

      const result = readMetadata.extractMetadata(
        fs.readFileSync(file, {encoding: 'utf8'})
      );
      let rawContent = result.rawContent;
      rawContent = rawContent.replace(
        /\]\(assets\//g,
        '](' + siteConfig.baseUrl + 'blog/assets/'
      );
      const metadata = Object.assign(
        {path: req.path.toString().split('blog/')[1], content: rawContent},
        result.metadata
      );
      metadata.id = metadata.title;

      let language = 'en';
      removeModuleAndChildrenFromCache('../core/BlogPostLayout.js');
      const BlogPostLayout = require('../core/BlogPostLayout.js');

      const blogPostComp = (
        <BlogPostLayout
          metadata={metadata}
          language={language}
          config={siteConfig}>
          {rawContent}
        </BlogPostLayout>
      );
      res.send(renderToStaticMarkup(blogPostComp));
    }
  });

  // handle all other main pages
  app.get('*.html', (req, res, next) => {
    // look for user provided html file first
    let htmlFile = req.path.toString().replace(siteConfig.baseUrl, '');
    htmlFile = CWD + '/pages/' + htmlFile;
    if (
      fs.existsSync(htmlFile) ||
      fs.existsSync(
        (htmlFile = htmlFile.replace(
          path.basename(htmlFile),
          'en/' + path.basename(htmlFile)
        ))
      )
    ) {
      if (siteConfig.wrapPagesHTML) {
        removeModuleAndChildrenFromCache('../core/Site.js');
        const Site = require('../core/Site.js');
        const str = renderToStaticMarkup(
          <Site
            language="en"
            config={siteConfig}
            metadata={{id: path.basename(htmlFile, '.html')}}>
            <div
              dangerouslySetInnerHTML={{
                __html: fs.readFileSync(htmlFile, {encoding: 'utf8'}),
              }}
            />
          </Site>
        );

        res.send(str);
      } else {
        res.send(fs.readFileSync(htmlFile, {encoding: 'utf8'}));
      }
      return;
    }

    // look for user provided react file either in specified path or in path for english files
    let file = req.path.toString().replace(/\.html$/, '.js');
    file = file.replace(siteConfig.baseUrl, '');
    let userFile = CWD + '/pages/' + file;

    let language = env.translation.enabled ? 'en' : '';
    const regexLang = /(.*)\/.*\.html$/;
    const match = regexLang.exec(req.path);
    const parts = match[1].split('/');
    const enabledLangTags = env.translation
      .enabledLanguages()
      .map(lang => lang.tag);

    for (let i = 0; i < parts.length; i++) {
      if (enabledLangTags.indexOf(parts[i]) !== -1) {
        language = parts[i];
      }
    }
    let englishFile = CWD + '/pages/' + file;
    if (language && language !== 'en') {
      englishFile = englishFile.replace('/' + language + '/', '/en/');
    }

    // check for: a file for the page, an english file for page with unspecified language, or an
    // english file for the page
    if (
      fs.existsSync(userFile) ||
      fs.existsSync(
        (userFile = userFile.replace(
          path.basename(userFile),
          'en/' + path.basename(userFile)
        ))
      ) ||
      fs.existsSync((userFile = englishFile))
    ) {
      // copy into docusaurus so require paths work
      let parts = userFile.split('pages/');
      let tempFile = __dirname + '/../pages/' + parts[1];
      tempFile = tempFile.replace(
        path.basename(file),
        'temp' + path.basename(file)
      );
      mkdirp.sync(path.dirname(tempFile));
      fs.copySync(userFile, tempFile);

      // render into a string
      removeModuleAndChildrenFromCache(tempFile);
      const ReactComp = require(tempFile);
      removeModuleAndChildrenFromCache('../core/Site.js');
      const Site = require('../core/Site.js');
      translate.setLanguage(language);
      const str = renderToStaticMarkup(
        <Site
          language={language}
          config={siteConfig}
          metadata={{id: path.basename(userFile, '.js')}}>
          <ReactComp language={language} />
        </Site>
      );

      fs.removeSync(tempFile);

      res.send(str);
    } else {
      next();
      return;
    }
  });

  // generate the main.css file by concatenating user provided css to the end
  app.get(/main\.css$/, (req, res) => {
    const mainCssPath =
      __dirname +
      '/../static/' +
      req.path.toString().replace(siteConfig.baseUrl, '/');
    let cssContent = fs.readFileSync(mainCssPath, {encoding: 'utf8'});

    let files = glob.sync(CWD + '/static/**/*.css');

    files.forEach(file => {
      if (isSeparateCss(file)) {
        return;
      }
      cssContent =
        cssContent + '\n' + fs.readFileSync(file, {encoding: 'utf8'});
    });

    if (
      !siteConfig.colors ||
      !siteConfig.colors.primaryColor ||
      !siteConfig.colors.secondaryColor
    ) {
      console.error(
        `${chalk.yellow(
          'Missing color configuration.'
        )} Make sure siteConfig.colors includes primaryColor and secondaryColor fields.`
      );
    }

    Object.keys(siteConfig.colors).forEach(key => {
      const color = siteConfig.colors[key];
      cssContent = cssContent.replace(new RegExp('\\$' + key, 'g'), color);
    });
    const codeColor = color(siteConfig.colors.primaryColor)
      .alpha(0.07)
      .string();
    cssContent = cssContent.replace(new RegExp('\\$codeColor', 'g'), codeColor);

    if (siteConfig.fonts) {
      Object.keys(siteConfig.fonts).forEach(key => {
        const fontString = siteConfig.fonts[key]
          .map(font => '"' + font + '"')
          .join(', ');
        cssContent = cssContent.replace(
          new RegExp('\\$' + key, 'g'),
          fontString
        );
      });
    }

    res.send(cssContent);
  });

  // serve static assets from these locations
  app.use(
    siteConfig.baseUrl + 'docs/assets/',
    express.static(CWD + '/../' + readMetadata.getDocsPath() + '/assets')
  );
  app.use(
    siteConfig.baseUrl + 'blog/assets/',
    express.static(CWD + '/blog/assets')
  );
  app.use(siteConfig.baseUrl, express.static(CWD + '/static'));
  app.use(siteConfig.baseUrl, express.static(__dirname + '/../static'));

  // "redirect" requests to pages ending with "/" or no extension so that,
  // for example, request to "blog" returns same result as "blog/index.html"
  app.get(/\/[^\.]*\/?$/, (req, res) => {
    let slash = req.path.toString().endsWith('/') ? '' : '/';
    request.get(
      'http://localhost:' + port + req.path + slash + 'index.html',
      (err, response, body) => {
        if (!err) {
          if (response) {
            res.status(response.statusCode).send(body);
          } else {
            console.error('No response');
          }
        } else {
          console.error('request failed:', err);
        }
      }
    );
  });

  app.listen(port);
  console.log('Open http://localhost:' + port + '/');
}

module.exports = execute;
// @flow

import path                 from 'path';
import fs                   from 'fs-extra';
import Promise              from 'bluebird';
import timm                 from 'timm';
import { mainStory, chalk } from 'storyboard';
import uuid                 from 'uuid';
import { base64ToUtf8 }     from '../common/base64';
import type {
  MapOf,
  StoryT,
  BluebirdPromise,
  InternalConfigT,
  InternalKeyT,
  InternalTranslationT,
}                           from '../common/types';
import parse                from './parseSources';
import compile              from './compileTranslations';
import collectReactIntlTranslations from './collectReactIntlTranslations';
import collectJsonTranslations from './collectJsonTranslations';
import * as importers       from './importData';

const DB_VERSION = 2;

const DEFAULT_CONFIG = {
  srcPaths: ['src'],
  srcExtensions: ['.js', '.jsx', '.coffee', '.cjsx'],
  langs: ['en'],
  msgFunctionNames: ['_t'],
  msgRegexps: [],
  fMinify: false,
  fJsOutput: true,
  fJsonOutput: true,
  fReactIntlOutput: true,
  dbVersion: DB_VERSION,
};

const RESPONSE_DELAY = 0;

// ==============================================
// Init
// ==============================================
let _readICUMessages = false;

function init(options: {
  fRecompile: boolean,
  localeDir: string,
  readICUMessages: boolean
}) {
  initLocaleDir(options);
  _readICUMessages = options.readICUMessages;
  const fMigrated = initConfig();
  initKeys();
  initTranslations();
  if (fMigrated || options.fRecompile) compileTranslations();
}


// ==============================================
// Locale dir
// ==============================================
let _localeDir: string;
function setLocaleDir(localeDir: string) { _localeDir = localeDir; }

function initLocaleDir(options: {
  localeDir: string,
}) {
  _localeDir = options.localeDir;
  try {
    fs.statSync(_localeDir);
  } catch (err) {
    mainStory.debug('db', `Creating folder ${chalk.cyan.bold(_localeDir)}...`);
    fs.mkdirSync(_localeDir);
  }
}

// ==============================================
// Config
// ==============================================
let _configPath: string;
let _config: InternalConfigT;

function setConfigPath(configPath: string) { _configPath = configPath; }
function setConfig(config: InternalConfigT) { _config = config; }

function initConfig(): boolean {
  _configPath = path.join(_localeDir, 'config.json');
  let fMigrated = false;
  try {
    mainStory.info('db', `Reading file ${chalk.cyan.bold(_configPath)}...`);
    fs.statSync(_configPath);
    readConfig();
    if (_config.dbVersion !== DB_VERSION) {
      migrateDatabase(_config.dbVersion);
      _config.dbVersion = DB_VERSION;
      fMigrated = true;
    }
    _config = timm.addDefaults(_config, DEFAULT_CONFIG);
    saveConfig();
    return fMigrated;
  } catch (err) {
    mainStory.error('db', `Error reading config: ${err.message}`,
      { attach: err, attachLevel: 'trace' });
    _config = DEFAULT_CONFIG;
    saveConfig();
    return fMigrated;
  }
}

function readConfig() { _config = readJson(_configPath); }
function saveConfig(options?: Object) { saveJson(_configPath, _config, options); }

function getConfig(): InternalConfigT { return _config; }

function updateConfig(
  newAttrs: Object,
  { story }: { story: StoryT },
): BluebirdPromise<InternalConfigT> {
  _config = timm.merge(_config, newAttrs);
  story.debug('db', 'New config:', { attach: _config });
  saveConfig({ story });
  return compileTranslations({ story })
  .then(() => _config);
}


// ==============================================
// Keys
// ==============================================
let _keyPath: string;
let _keys: MapOf<InternalKeyT> = {};

function setKeyPath(keyPath: string) { _keyPath = keyPath; }
function setKeys(keys: MapOf<InternalKeyT>) { _keys = keys; }

function initKeys() {
  _keyPath = path.join(_localeDir, 'keys.json');
  try {
    fs.statSync(_keyPath);
  } catch (err) {
    saveKeys();
  } finally {
    mainStory.info('db', `Reading file ${chalk.cyan.bold(_keyPath)}...`);
    readKeys();
  }
}

function readKeys() { _keys = readJson(_keyPath); }
function saveKeys(options?: Object) { saveJson(_keyPath, _keys, options); }

function getKeys(): Array<InternalKeyT> {
  return Object.keys(_keys).map((id) => _keys[id]);
}

function getKey(id: string): ?InternalKeyT {
  return _keys[id];
}

function createKey(newAttrs: Object): BluebirdPromise<?InternalKeyT> {
  const id = newAttrs.context != null
    ? `${newAttrs.context}_${newAttrs.text}`
    : newAttrs.text;
  _keys[id] = {
    id,
    context: newAttrs.context || null,
    text: newAttrs.text,
    firstUsed: newAttrs.firstUsed,
    unusedSince: newAttrs.unusedSince || null,
    sources: [],
  };
  saveKeys();
  return compileTranslations()
  .then(() => _keys[id]);
}

function updateKey(id: string, newAttrs: Object): BluebirdPromise<?InternalKeyT> {
  _keys[id] = timm.merge(_keys[id], newAttrs);
  saveKeys();
  return compileTranslations()
  .then(() => _keys[id]);
}

function deleteKey(id: string): BluebirdPromise<?InternalKeyT> {
  const item = _keys[id];
  delete _keys[id];
  saveKeys();
  return compileTranslations()
  .delay(RESPONSE_DELAY)
  .then(() => item);
}

function parseSrcFiles({ story }: { story: StoryT }) {
  const { srcPaths, srcExtensions, msgFunctionNames, msgRegexps } = _config;

  const curKeys = parse({
    srcPaths,
    srcExtensions,
    msgFunctionNames,
    msgRegexps,
    story,
    readICUMessages: _readICUMessages,
  });
  const now = new Date().toISOString();

  const unusedKeys = [];
  Object.keys(_keys).forEach((id) => {
    const key = _keys[id];
    if (curKeys[id]) {
      curKeys[id].firstUsed = key.firstUsed;
    } else {
      unusedKeys.push(id);
      curKeys[id] = key;
      key.unusedSince = key.unusedSince || now;
      key.sources = [];
    }
  });
  if (unusedKeys.length) {
    story.debug('db', `${chalk.bold('Unused')} keys: ${unusedKeys.length}`, {
      attach: unusedKeys.map(base64ToUtf8),
    });
  }

  const newKeys = [];
  Object.keys(curKeys).forEach((id) => {
    const key = curKeys[id];
    if (!key.firstUsed) {
      newKeys.push(id);
      key.firstUsed = now;
    }
    _keys[id] = key;
  });
  if (newKeys.length) {
    story.debug('db', `${chalk.bold('New')} keys: ${newKeys.length}`, {
      attach: newKeys.map(base64ToUtf8),
    });
  }

  saveKeys({ story });
  return compileTranslations({ story })
  .then(() => _keys);
}


// ==============================================
// Translations
// ==============================================
let _translations: MapOf<InternalTranslationT> = {};

const getLangPath = (lang: string): string =>
  path.join(_localeDir, `${lang}.json`);
const getCompiledLangPath = (lang: string): string =>
  path.join(_localeDir, `${lang}.js`);
const getJsonLangPath = (lang: string): string =>
  path.join(_localeDir, `${lang}.out.json`);
const getReactIntlLangPath = (lang: string): string =>
  path.join(_localeDir, `${lang}.reactIntl.json`);
function setTranslations(translations: MapOf<InternalTranslationT>) {
  _translations = translations;
}

function initTranslations() {
  for (const lang of _config.langs) {
    const langPath = getLangPath(lang);
    try {
      fs.statSync(langPath);
    } catch (err) {
      saveJson(langPath, {});
    } finally {
      mainStory.info('db', `Reading file ${chalk.cyan.bold(langPath)}...`);
      readTranslations(lang);
    }
  }
}

function readTranslations(lang: string) {
  const translations = readJson(getLangPath(lang));
  if (translations) {
    _translations = timm.merge(_translations, translations);
  }
}

function saveTranslations(lang: string, options: Object) {
  const langTranslations = {};
  Object.keys(_translations).forEach((translationId) => {
    const translation = _translations[translationId];
    if (translation.lang === lang) {
      langTranslations[translation.id] = translation;
    }
  });
  saveJson(getLangPath(lang), langTranslations, options);
}

function getTranslations() {
  return Object.keys(_translations).map((id) => _translations[id]);
}

function getLangTranslations(lang: string): Array<InternalTranslationT> {
  const out = [];
  Object.keys(_translations).forEach((translationId) => {
    const translation = _translations[translationId];
    if (translation.lang === lang) {
      out.push(translation);
    }
  });
  return out;
}

function getKeyTranslations(keyId: string): Array<InternalTranslationT> {
  const out = [];
  Object.keys(_translations).forEach((translationId) => {
    const translation = _translations[translationId];
    if (translation.keyId === keyId) {
      out.push(translation);
    }
  });
  return out;
}

function getTranslation(id: string): ?InternalTranslationT {
  return _translations[id];
}

function createTranslation(
  newAttrs: Object,
  { story }: { story: StoryT },
): BluebirdPromise<?InternalTranslationT> {
  const { lang, translation, fuzzy, keyId } = newAttrs;
  if (!lang) throw new Error('Translation language must be specified');
  if (keyId == null) throw new Error('Translation key must be specified');
  const id = uuid.v4();
  _translations[id] = { id, lang, translation, fuzzy, keyId };
  saveTranslations(lang, { story });
  return compileTranslations({ story })
  .delay(RESPONSE_DELAY)
  .then(() => _translations[id]);
}

function updateTranslation(
  id: string,
  newAttrs: Object,
  { story }: { story: StoryT },
): BluebirdPromise<?InternalTranslationT> {
  _translations[id] = timm.merge(_translations[id], newAttrs);
  saveTranslations(_translations[id].lang, { story });
  return compileTranslations({ story })
  .delay(RESPONSE_DELAY)
  .then(() => _translations[id]);
}

function deleteTranslation(
  id: string,
  { story }: { story: StoryT },
): BluebirdPromise<?InternalTranslationT> {
  const item = _translations[id];
  const { lang } = _translations[id];
  delete _translations[id];
  saveTranslations(lang, { story });
  return compileTranslations({ story })
  .delay(RESPONSE_DELAY)
  .then(() => item);
}

function compileTranslations(
  { story: baseStory }: { story?: StoryT } = {},
): BluebirdPromise<*> {
  const story = (baseStory || mainStory).child({ src: 'db', title: 'Compile translations' });
  const keys = _keys;
  return Promise.resolve()
  .then(() => {
    const { fMinify, fJsOutput, fReactIntlOutput, fJsonOutput, langs } = _config;
    const allTranslations = getAllTranslations(langs, story);
    Object.keys(allTranslations).forEach((lang) => {
      const compiledLangPath = getCompiledLangPath(lang);
      const translations = allTranslations[lang];
      if (fJsOutput) {
        const fnTranslate = compile({ lang, keys, translations, fMinify, story });
        story.debug('db', `Writing file ${chalk.cyan.bold(compiledLangPath)}...`);
        fs.writeFileSync(compiledLangPath, fnTranslate, 'utf8');
      }
      if (fReactIntlOutput) {
        const reactIntlLangPath = getReactIntlLangPath(lang);
        const reactIntlTranslations = collectReactIntlTranslations({
          lang, keys, translations, story,
        });
        saveJson(reactIntlLangPath, reactIntlTranslations, { story });
      }
      if (fJsonOutput) {
        const jsonLangPath = getJsonLangPath(lang);
        const jsonTranslations = collectJsonTranslations({
          lang, keys, translations, story,
        });
        saveJson(jsonLangPath, jsonTranslations, { story });
      }
    });
  })
  .catch((err) => {
    story.error('db', 'Could not compile translations:', { attach: err });
    throw err;
  })
  .finally(() => story.close());
}

// function objToArray(obj) {
//   const out = [];
//   Object.keys(obj).forEach(key => {
//     out.push(obj[key]);
//   });
//   return out;
// }

function getAllTranslations(
  langs: Array<string>,
  /* story: StoryT, */
): MapOf<Array<InternalTranslationT>> {
  // Determine lang structure
  const langStructure = {};
  const sortedLangs = langs.slice().sort();
  // story.debug('db', 'Sorted languages', { attach: sortedLangs });
  sortedLangs.forEach((lang) => {
    langStructure[lang] = { parent: null, children: [] };
    const tokens = lang.split(/[_-]/);
    for (let i = 0; i < tokens.length; i++) {
      const tmpLang = tokens.slice(0, i + 1).join('-');
      if (!langStructure[tmpLang]) langStructure[tmpLang] = { parent: null, children: [] };
      if (i > 0) {
        const parentLang = tokens.slice(0, i).join('-');
        langStructure[parentLang].children.push(tmpLang);
        langStructure[tmpLang].parent = parentLang;
      }
    }
  });
  // story.debug('db', 'Language tree', { attach: langStructure });

  // Collect all translations for languages, from top to bottom:
  // - Add all children translations (backup)
  // - Add ancestor translations (including those coming up from other branches)
  // - Add own translations
  // This algorithm may result in multiple translations for the same key, but the latest one
  // should have higher priority (this is used by `compileTranslations()` during flattening).
  // Higher priority is guaranteed by the order in which languages are processed,
  // and the order in which translations are added to the array.
  const allLangs = Object.keys(langStructure).sort();
  allLangs.forEach((lang) => {
    const childrenTranslations = getChildrenTranslations(langStructure, lang, []);
    // story.debug('db', `Children translations for ${lang}`, { attach: childrenTranslations });
    const parentTranslations = getParentTranslations(langStructure, lang);
    // story.debug('db', `Parent translations for ${lang}`, { attach: parentTranslations });
    const ownTranslations = getLangTranslations(lang);
    // story.debug('db', `Own translations for ${lang}`, { attach: ownTranslations });
    langStructure[lang].translations = childrenTranslations
      .concat(parentTranslations, ownTranslations);
  });

  // Replace lang structure by the translations themselves
  const out = {};
  Object.keys(langStructure).forEach((lang) => {
    out[lang] = langStructure[lang].translations;
  });
  // story.debug('db', 'All translations', { attach: out });
  return out;
}

function getChildrenTranslations(
  langStructure: MapOf<Object>,
  lang: string,
  translations0: Array<InternalTranslationT>,
): Array<InternalTranslationT> {
  let translations = translations0;
  langStructure[lang].children.forEach((childLang) => {
    translations = translations.concat(getLangTranslations(childLang));
    translations = getChildrenTranslations(langStructure, childLang, translations);
  });
  return translations;
}

function getParentTranslations(
  langStructure: MapOf<Object>,
  lang: string,
): Array<InternalTranslationT> {
  let out = [];
  const tokens = lang.split(/[_-]/);
  if (tokens.length < 1) return out;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tmpLang = tokens.slice(0, i + 1).join('-');
    out = out.concat(langStructure[tmpLang].translations);
  }
  return out;
}

// ==============================================
// Merge keys and translations from old stores
// ==============================================
function importV0(dir: string) {
  const story = mainStory.child({ src: 'db', title: 'Import v0' });
  const { langs, keys, translations } = importers.importV0({
    langs: _config.langs,
    keys: _keys,
    translations: _translations,
    dir, story,
  });
  if (langs !== _config.langs) updateConfig({ langs }, { story });
  if (keys !== _keys) {
    _keys = keys;
    saveKeys({ story });
  }
  if (translations !== _translations) {
    _translations = translations;
    for (const lang of _config.langs) {
      saveTranslations(lang, { story });
    }
  }
  compileTranslations();
  story.close();
}

function migrateDatabase(prevDbVersion: number) {
  const story = mainStory.child({
    src: 'db',
    title: `Upgrade DB ${prevDbVersion} -> ${DB_VERSION}`,
  });
  if (prevDbVersion == null || prevDbVersion < 2) {
    importers.importToV2({ langs: _config.langs, dir: _localeDir, story });
  }
  story.close();
}

// ==============================================
// Helpers
// ==============================================
function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(
  filePath: string,
  obj: any,
  { story = mainStory }: { story?: StoryT } = {}
) {
  story.debug('db', `Writing file ${chalk.cyan.bold(filePath)}...`);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, '  '), 'utf8');
}

// ==============================================
// Public API
// ==============================================
export {
  init,

  getConfig, updateConfig,
  getKeys, getKey, createKey, updateKey, deleteKey,
  getTranslations, getLangTranslations, getKeyTranslations, getTranslation,
  createTranslation, updateTranslation, deleteTranslation,

  parseSrcFiles,
  compileTranslations,
  importV0,
  saveJson,

  // Only for unit tests
  DEFAULT_CONFIG as _DEFAULT_CONFIG,
  setLocaleDir as _setLocaleDir,
  setKeyPath as _setKeyPath,
  setConfigPath as _setConfigPath,
  setConfig as _setConfig,
  setKeys as _setKeys,
  setTranslations as _setTranslations,
};

// @flow

/* eslint-disable global-require */
import fs                   from 'fs';
import path                 from 'path';
import slash                from 'slash';
import { mainStory, chalk } from 'storyboard';
import diveSync             from 'diveSync';
import { utf8ToBase64 }     from '../common/base64';
import type {
  MapOf,
  StoryT,
  InternalKeyT,
  codeLocationT,
}                           from '../common/types';

// Enable react-intl integration only when we have the necessary packages
let fReactIntl = false;
let babelCore;
const babelConfig = {
  presets: [],
  plugins: ['react-intl'],
};
try {
  babelCore = require('babel-core');
  require('babel-plugin-react-intl');

  fReactIntl = true;
  try {
    const babelrc = JSON.parse(fs.readFileSync('.babelrc', 'utf8'));
    if (babelrc.presets) babelConfig.presets = babelConfig.presets.concat(babelrc.presets);
    if (babelrc.plugins) babelConfig.plugins = babelrc.plugins.concat(babelConfig.plugins);
  } catch (err) {
    mainStory.warn('parser',
      'Could not find your .babelrc file; using default config for React Intl integration');
  }
} catch (err) {
  mainStory.warn('parser', 'Disabled React Intl integration');
  // eslint-disable-line max-len
  mainStory.warn('parser',
    'If you need it, make sure you install babel-core and babel-plugin-react-intl');
}

// const REGEXP_TRANSLATE_CMDS = [
//   /_t\s*\(\s*"(.*?)"/g,
//   /_t\s*\(\s*'(.*?)'/g,
// ];

const getRegexps = (
  msgFunctionNames: Array<string>,
  msgRegexps: Array<string>,
): Array<RegExp> => {
  const out = [];
  if (msgFunctionNames) {
    msgFunctionNames.forEach((fnName) => {
      // Escape $ characters, which are legal in function names
      const escapedFnName = fnName.replace(/([\$])/g, '\\$1'); // eslint-disable-line no-useless-escape

      // Looking for something like:
      // * i18n("xk s fjkl"   [other arguments to the function are not parsed]
      // * i18n ( "xk s fjkl"
      // * i18n('xk s fjkl'
      out.push(new RegExp(`${escapedFnName}\\s*\\(\\s*"([\\s\\S]*?)"`, 'gm'));
      out.push(new RegExp(`${escapedFnName}\\s*\\(\\s*'([\\s\\S]*?)'`, 'gm'));
    });
  }
  if (msgRegexps) {
    msgRegexps.forEach((reStr) => {
      out.push(new RegExp(reStr, 'gm'));
    });
  }
  return out;
};

const parse = ({ srcPaths, srcExtensions, msgFunctionNames, msgRegexps, story, readICUMessages }: {|
  srcPaths: Array<string>,
  srcExtensions: Array<string>,
  msgFunctionNames: Array<string>,
  msgRegexps: Array<string>,
  story: StoryT,
  readICUMessages: boolean,
|}): MapOf<InternalKeyT> => {
  const regexps = getRegexps(msgFunctionNames, msgRegexps);
  const keys = {};
  // only JSON!
  if (readICUMessages) {
    srcExtensions = ['.json']; // eslint-disable-line no-param-reassign
  }
  const diveOptions = { filter: (filePath, fDir) => {
    if (fDir) return true;
    return (srcExtensions.indexOf(path.extname(filePath)) >= 0);
  } };
  const diveProcess = (err, filePath) => {
    const finalFilePath = path.normalize(filePath);
    story.info('parser', `Processing ${chalk.cyan.bold(finalFilePath)}...`);
    const fileContents = fs.readFileSync(finalFilePath, 'utf8');
    // needs better on/off handling - parse plugins maybe?
    if (!readICUMessages) {
      parseWithRegexps(keys, finalFilePath, fileContents, regexps);
      if (fReactIntl) parseReactIntl(keys, finalFilePath, fileContents, story);
    }
    if (readICUMessages) parseIcuMessages(keys, finalFilePath, fileContents, story);
  };
  srcPaths.forEach((srcPath) => diveSync(srcPath, diveOptions, diveProcess));
  return keys;
};

const parseWithRegexps = (
  keys: MapOf<InternalKeyT>,
  filePath: string,
  fileContents: string,
  regexps: Array<RegExp>,
): void => {
  regexps.forEach((re) => {
    let match;
    while ((match = re.exec(fileContents))) {
      addMessageToKeys(keys, match[1], filePath);
    }
  });
};

const handleICUMessageObject = ({
  message,
  keys,
  filePath,
}: {|
  message: Object,
  keys: MapOf<InternalKeyT>,
  filePath: string,
|}) :void => {
  const {
    defaultMessage: utf8,
    description,
    id: reactIntlId,
    // file,
    start,
    end,
  } = message;

  const extras: {
    reactIntlId: string,
    description: string,
    context: string,
    start?: codeLocationT,
    end?: codeLocationT
  } = {
    reactIntlId,
    description,
    context: reactIntlId,
  };

  if (start && end) {
    extras.start = start;
    extras.end = end;
  }
  addMessageToKeys(keys, utf8, filePath, extras);
};

const parseReactIntl = (
  keys: MapOf<InternalKeyT>,
  filePath: string,
  fileContents: string,
  story: StoryT,
): void => {
  try {
    const { messages } = babelCore.transform(fileContents, babelConfig).metadata['react-intl'];
    if (messages) {
      messages.forEach((message) => handleICUMessageObject({ message, keys, filePath }));
    }
  } catch (err2) {
    story.error('parser', 'Error extracting React Intl messages', { attach: err2 });
  }
};

const parseIcuMessages = (
  keys: MapOf<InternalKeyT>,
  filePath: string,
  fileContents: string,
  story: StoryT,
): void => {
  try {
    const json = JSON.parse(fileContents);
    // since JSON files could be non ICU messages, we have to add some checks here
    if (json && Array.isArray(json)) {
      json.forEach((message) => {
        // if we have an object and it has id and defaultMessage, we assume it's an ICU message
        if (typeof message === 'object' && message.id && message.defaultMessage) {
          handleICUMessageObject({ message, keys, filePath });
        }
      });
    }
  } catch (err2) {
    story.error('parser', 'Error extracting ICU messages', { attach: err2 });
  }
};

const addMessageToKeys = (
  keys: MapOf<InternalKeyT>,
  utf8: string,
  filePath: string,
  extras?: {
    start?: codeLocationT,
    end?: codeLocationT
  } = {},
): void => {
  // TODO: that can fail!
  const tokens = utf8.split('_');
  let context;
  let text;
  if (tokens.length >= 2) {
    context = tokens.shift();
    text = tokens.join('_');
  } else {
    context = null;
    text = tokens[0];
  }
  const base64 = utf8ToBase64(utf8);
  // eslint-disable-next-line no-param-reassign
  keys[base64] = keys[base64] || {
    id: base64,
    context,
    text,
    ...extras,
    firstUsed: null,
    unusedSince: null,
    sources: [],
  };
  // TODO: if we have start/end, add that to the filePath in a nicer way
  // maybe making the sources array an object: { file, start, end }
  let sourceString = slash(filePath);
  if (extras && extras.start && extras.end) {
    const { start, end } = extras;
    sourceString += ` (${start.line}:${start.column}-${end.line}:${end.column})`;
  }
  keys[base64].sources.push(sourceString);
};

// ======================================================
// Public API
// ======================================================
export default parse;

// Only for unit tests
export {
  getRegexps as _getRegexps,
  parseWithRegexps as _parseWithRegexps,
  parseReactIntl as _parseReactIntl,
};

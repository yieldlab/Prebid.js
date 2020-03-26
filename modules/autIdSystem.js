/**
 * This module adds AUT to the User ID module
 * The {@link module:modules/userId} module is required
 * @module modules/autIdSystem
 * @requires module:modules/userId
 */

import * as utils from '../src/utils.js'
import * as urlLib from '../src/url.js'
import { submodule } from '../src/hook.js'

const autCookieName = '_autgif2';

/** @type {Submodule} */
export const autIdSubmodule = {
  /**
   * used to link submodule with config
   * @type {string}
   */
  name: 'aut',
  /**
   * decode the stored id value for passing to bid requests
   * @function decode
   * @param {(Object|string)} value
   * @returns {(Object|undefined)}
   */
  decode(value) {
    return value
  },
  /**
   * performs action to obtain id and return a value in the callback's response argument
   * @function
   * @param {SubmoduleParams} [configParams]
   * @returns {IdResponse|undefined}
   */
  getId(configParams) {
    if (!configParams || typeof configParams.url !== 'string') {
      utils.logError('AUT needs params.url to be defined');
      return;
    }
    const host = urlLib.parse(configParams.url).host;
    const url = 'https://' + host + '/aut.gif';
    const autCall = new Image();
    autCall.src = url;

    const autId = utils.getCookie(autCookieName);
    return { id: autId ? { aut: autId } : undefined };
  }
};

submodule('userId', autIdSubmodule);

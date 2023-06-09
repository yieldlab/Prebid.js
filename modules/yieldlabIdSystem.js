/**
 * This module adds yieldlabId to the User ID module
 * The {@link module:modules/userId} module is required
 * @module modules/yieldlabIdSystem
 * @requires module:modules/userId
 */

import {submodule} from '../src/hook.js';

/** @type {Submodule} */
export const yieldlabIdSubmodule = {
  /**
   * used to link submodule with config
   * @type {string}
   */
  name: 'yieldlab',
  /**
   * decode the stored id value for passing to bid requests
   * @function decode
   * @param {(Object|string)} value
   * @returns {(Object|undefined)}
   */
  decode(value) {
    return (value && typeof value['ylid'] === 'string') ? { 'ylid': value['ylid'] } : (value && Array.isArray(value['ylid'])) ? { 'ylid': value['ylid'].join(',') } : undefined;
  },
  /**
   * performs action to obtain id and return a value in the callback's response argument
   * @function
   * @param {SubmoduleConfig} [config]
   * @param {ConsentData} [consentData]
   * @param {(Object|undefined)} cacheIdObj
   * @returns {IdResponse|undefined}
   */
  getId(config) {
    /* currently not possible */
    return {};
  }
};

submodule('userId', yieldlabIdSubmodule);

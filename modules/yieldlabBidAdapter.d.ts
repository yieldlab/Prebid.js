export interface YieldlabBidderParams {
  /**
   * Yieldlab adslot id. Sent as `imp.tagid`, always as a string.
   */
  adslotId: string | number;
  /**
   * Yieldlab supply id.
   */
  supplyId: string | number;
  /**
   * Key/values the adserver matches campaigns against. Merged across all
   * ad units in the request - later ad units win on a shared key - and sent as
   * `ext.vm.targeting` in the form `k1=v1&k2=v2`.
   */
  targeting?: Record<string, string | number>;
  /**
   * External id used in reporting. The first one found across the request's
   * ad units is sent as `ext.vm.externalid`.
   */
  extId?: string;
  /**
   * Content the ad unit appears next to. The first one found across the
   * request's ad units is copied into `site.content` (or `app.content`).
   */
  iabContent?: YieldlabIabContent;
}

/**
 * IAB content fields, copied into the request's `content` as given, over any
 * first-party content. Values may be strings or numbers; null values are
 * skipped. `live` is sent as the OpenRTB `livestream` unless `livestream` is
 * set too. Prefer setting `ortb2.site.content` (or `ortb2.app.content`).
 */
export interface YieldlabIabContent {
  id?: string;
  episode?: string | number;
  title?: string;
  series?: string;
  season?: string;
  artist?: string;
  genre?: string;
  isrc?: string;
  url?: string;
  cat?: string[];
  context?: string | number;
  keywords?: string | string[];
  /** Alias of `livestream`. */
  live?: string | number;
  livestream?: string | number;
  /** Any other OpenRTB content field, passed through unchanged. */
  [field: string]: unknown;
}

declare module '../src/adUnits' {
  interface BidderParams {
    yieldlab: YieldlabBidderParams;
  }
}

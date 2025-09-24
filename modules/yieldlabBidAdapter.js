import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';
import { Renderer } from '../src/Renderer.js';
import { deepAccess, isArray, timestamp } from '../src/utils.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';

/**
 * @typedef {import('../src/adapters/bidderFactory.js').BidRequest} BidRequest
 * @typedef {import('../src/adapters/bidderFactory.js').Bid} Bid
 * @typedef {import('../src/adapters/bidderFactory.js').ServerResponse} ServerResponse
 * @typedef {import('../src/adapters/bidderFactory.js').ServerRequest} ServerRequest
 * @typedef {import('../src/adapters/bidderFactory.js').SyncOptions} SyncOptions
 * @typedef {import('../src/adapters/bidderFactory.js').UserSync} UserSync
 */

/** Keep this endpoint for local testing (see: hello world example). */
const ENDPOINT = 'https://ad.yieldlab.net';
const ORTB_PATH = '/ortb';
const BIDDER_CODE = 'yieldlab';
const BID_RESPONSE_TTL_SEC = 300;
const CURRENCY_CODE = 'EUR';
const OUTSTREAMPLAYER_URL = 'https://ad.adition.com/dynamic.ad?a=o193092&ma_loadEvent=ma-start-event';
const GVLID = 70;
const DIMENSION_SIGN = 'x';

const MTYPE = {
  BANNER: 1,
  VIDEO: 2,
  NATIVE: 4
};

export const spec = {
  code: BIDDER_CODE,
  gvlid: GVLID,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],

  /**
   * Validate the incoming bid params.
   * Requires both `adslotId` and `supplyId`.
   * @param {object} bid
   * @returns {boolean}
   */
  isBidRequestValid(bid) {
    return !!(bid && bid.params && bid.params.adslotId && bid.params.supplyId);
  },

  /**
   * Build the ORTB request via Prebid’s converter.
   * @param {BidRequest[]} validBidRequests
   * @param {*} bidderRequest
   * @returns {ServerRequest|ServerRequest[]}
   */
  buildRequests(validBidRequests, bidderRequest) {
    const requestFn = (buildRequest, imps, bidderReq, ctx) => {
      const ortb = buildRequest(imps, bidderReq, ctx);

      ortb.tmax = (bidderReq?.timeout != null) ? bidderReq.timeout : ortb.tmax;

      if (bidderReq?.auctionId) {
        ortb.id = bidderReq.auctionId;
      }

      if (!ortb.cur || !ortb.cur.length) {
        ortb.cur = [CURRENCY_CODE];
      }

      const page = bidderReq?.refererInfo?.page;
      if (page) {
        ortb.site = ortb.site || {};
        if (!ortb.site.page) ortb.site.page = page;
      }

      const ref = bidderReq?.refererInfo?.ref;
      if (ref) {
        ortb.site = ortb.site || {};
        if (!ortb.site.ref) ortb.site.ref = ref;
      }

      // GDPR (map to 2.6 + 2.5 fallback)
      applyConsent(ortb, bidderReq);

      applyEids(ortb, validBidRequests);

      applySchain(ortb, validBidRequests);

      applyImps(ortb, validBidRequests);

      applyBidFloors(ortb, validBidRequests);

      applyIabContent(ortb, validBidRequests);

      applyVmExt(ortb, validBidRequests, bidderReq);

      return ortb;
    };

    const bidResponseFn = (buildBidResponse, bid, ctx) => {
      // mtype hint if missing
      if (bid.mtype == null) {
        if (deepAccess(ctx, 'bidRequest.mediaTypes.banner')) {
          bid.mtype = MTYPE.BANNER;
        } else if (deepAccess(ctx, 'bidRequest.mediaTypes.video')) {
          bid.mtype = MTYPE.VIDEO;
        } else if (deepAccess(ctx, 'bidRequest.mediaTypes.native')) {
          bid.mtype = MTYPE.NATIVE;
        }
      }

      const resp = buildBidResponse(bid, ctx);

      ensureCreativeId(resp, bid, ctx);
      ensureVideoAsset(resp, bid, ctx);
      ensureBannerSize(resp, ctx);

      if (resp.mediaType === VIDEO && deepAccess(ctx, 'bidRequest.mediaTypes.video')) {
        setVideoSize(resp, ctx);
        installOutstreamRendererIfNeeded(resp, ctx);
      }

      attachNativeFromAdm(resp, bid);

      ensureMeta(resp, bid);

      return resp;
    };

    const converter = ortbConverter({
      context: {
        currency: CURRENCY_CODE,
        netRevenue: false,
        ttl: BID_RESPONSE_TTL_SEC,
        nativeRequest: { eventtrackers: [{ event: 1, methods: [1, 2] }] }
      },
      request: requestFn,
      bidResponse: bidResponseFn
    });

    const ortbRequest = converter.toORTB({ bidderRequest, bidRequests: validBidRequests });
    const url = `${ENDPOINT}${ORTB_PATH}`;

    return {
      method: 'POST',
      url,
      data: JSON.stringify(ortbRequest),
      options: {
        contentType: 'application/json',
        customHeaders: { 'x-openrtb-version': '2.6' }
      },
      converter,
      ortbRequest
    };
  },

  /**
   * Map ORTB response to Prebid bids.
   * @param {ServerResponse} serverResponse
   * @param {ServerRequest} originalRequest
   * @returns {Bid[]}
   */
  interpretResponse(serverResponse, originalRequest) {
    if (!originalRequest?.converter || !originalRequest?.ortbRequest) {
      return [];
    }
    const body = serverResponse?.body;
    if (!body) {
      return [];
    }

    unwrapNativeAdm(body);

    const { bids } = originalRequest.converter.fromORTB({
      request: originalRequest.ortbRequest,
      response: body
    });

    return bids;
  },

  /**
   * Register the user sync pixels which should be dropped after the auction.
   */
  getUserSyncs(syncOptions, serverResponses, gdprConsent, uspConsent) {
    const syncs = [];

    if (syncOptions.iframeEnabled) {
      const params = [];
      params.push(`ts=${timestamp()}`);
      params.push(`type=h`);
      if (gdprConsent && (typeof gdprConsent.gdprApplies === 'boolean')) {
        params.push(`gdpr=${Number(gdprConsent.gdprApplies)}`);
      }
      if (gdprConsent && (typeof gdprConsent.consentString === 'string')) {
        params.push(`gdpr_consent=${gdprConsent.consentString}`);
      }
      syncs.push({
        type: 'iframe',
        url: `${ENDPOINT}/d/6846326/766/2x2?${params.join('&')}`,
      });
    }

    return syncs;
  },
};

/**
 * Is this an outstream context?
 * @param {Object} format
 * @returns {Boolean}
 */
function isOutstream(format) {
  const context = deepAccess(format, 'mediaTypes.video.context');
  return (context === 'outstream');
}

/**
 * Gets optional player size.
 * @param {Object} format
 * @returns {Array|undefined}
 */
function getPlayerSize(format) {
  const playerSize = deepAccess(format, 'mediaTypes.video.playerSize');
  return (playerSize && isArray(playerSize[0])) ? playerSize[0] : playerSize;
}

/**
 * Attach outstream renderer when needed.
 * @param {Bid} resp
 * @param {Object} ctx
 */
function installOutstreamRendererIfNeeded(resp, ctx) {
  if (!isOutstream(ctx.bidRequest)) {
    return;
  }
  const renderer = Renderer.install({
    id: ctx.bidRequest.bidId,
    url: OUTSTREAMPLAYER_URL,
    loaded: false
  });
  renderer.setRender(outstreamRender);
  resp.renderer = renderer;
}

/**
 * Set width/height from requested player size if present.
 * @param {Bid} resp
 * @param {Object} ctx
 */
function setVideoSize(resp, ctx) {
  const size = getPlayerSize(ctx.bidRequest);
  if (size) {
    resp.width = size[0];
    resp.height = size[1];
  }
}

/**
 * Renderer entry point for outstream.
 * @param {Bid} bid
 */
function outstreamRender(bid) {
  bid.renderer.push(() => {
    window.ma_width = bid.width;
    window.ma_height = bid.height;
    window.ma_vastUrl = bid.vastUrl || bid.vastXml;
    window.ma_vastXml = bid.vastXml || '';
    window.ma_container = bid.adUnitCode;
    window.document.dispatchEvent(new Event('ma-start-event'));
  });
}

/**
 * Convert an object of key/values into an unencoded query string: k=v&k2=v2
 * @param {Object} obj
 * @returns {string}
 */
function kvToQueryString(obj) {
  /** keep order stable */
  const parts = [];
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const val = obj[key];
      parts.push(key + '=' + val);
    }
  }
  return parts.join('&');
}

/**
 * Merge all params.targeting objects across adunits, later values overwrite earlier values.
 * @param {BidRequest[]} bidRequests
 * @returns {Object}
 */
function mergeKeyValues(bidRequests) {
  return bidRequests.reduce((acc, br) => {
    const t = br.params && br.params.targeting;
    if (t && typeof t === 'object') {
      Object.assign(acc, t);
    }
    return acc;
  }, {});
}

/**
 * Ensure creativeId and dealId presence on the PBJS response.
 * @param {Bid} resp
 * @param {Object} bid
 * @param {Object} ctx
 */
function ensureCreativeId(resp, bid, ctx) {
  if (!resp.creativeId) {
    resp.creativeId = bid.crid || bid.adid || bid.id || bid.impid || ('yl-' + ctx.bidRequest.bidId);
  }
  if (!resp.dealId && bid.dealid) {
    resp.dealId = bid.dealid;
  }
}

/**
 * Add advertiser domains fallback and pass DSA if provided.
 * (Used in bidResponse and interpretResponse.)
 * @param {Bid} resp
 * @param {Object} bid
 */
function ensureMeta(resp, bid) {
  resp.meta = resp.meta || {};
  if (!resp.meta.advertiserDomains || !resp.meta.advertiserDomains.length) {
    const adomain = bid?.adomain || [];
    resp.meta.advertiserDomains = adomain.length ? adomain : ['n/a'];
  }
  if (bid?.ext?.dsa) {
    resp.meta.dsa = bid.ext.dsa;
  }
}

/**
 * Unwrap "adm" when it is a JSON string like {"native": {...}} to just {...}.
 * No-op for non-JSON (e.g., VAST XML or HTML).
 * Also hints "mtype" to native when appropriate.
 * @param {Object} body ORTB response body
 */
function unwrapNativeAdm(body) {
  (body.seatbid || []).forEach((seat) => {
    (seat.bid || []).forEach((b) => {
      const s = (typeof b.adm === 'string') ? b.adm.trim() : null;
      if (!s || s[0] !== '{') {
        return;
      }
      try {
        const j = JSON.parse(s);
        if (j && j.native && typeof j.native === 'object') {
          b.adm = JSON.stringify(j.native);
          if (b.mtype == null) {
            b.mtype = MTYPE.NATIVE;
          }
        }
      } catch (_) {
        // ignore malformed JSON
      }
    });
  });
}

/**
 * Populate "resp.native" from an ORTB Native "adm" JSON string when the converter
 * didn’t already build a Prebid Native object.
 *
 * Handles both:
 *   - adm: {"native": {...}}
 *   - adm: {...}
 *
 * Sets:
 *   - resp.native.clickUrl
 *   - resp.native.impressionTrackers
 *   - resp.native.assets
 *   - resp.native.ortb  (raw parsed object for debugging/passthrough)
 *
 * Silently no-ops on malformed JSON or non-native payloads.
 *
 * @param {Object} resp - Prebid bid response being built
 * @param {Object} bid  - Raw ORTB bid (seatbid.bid[i])
 */
function attachNativeFromAdm(resp, bid) {
  if (resp.mediaType !== NATIVE || resp.native || typeof bid.adm !== 'string') {
    return;
  }

  try {
    const parsed = JSON.parse(bid.adm);
    const n = (parsed && typeof parsed === 'object' && parsed.native) ? parsed.native : parsed;
    if (!n || typeof n !== 'object') {
      return;
    }

    const assets = Array.isArray(n.assets) ? n.assets : [];
    const imptrackers = Array.isArray(n.imptrackers) ? n.imptrackers : [];

    // Only attach if it looks like a native payload
    if (assets.length || n.link || imptrackers.length) {
      resp.native = {
        clickUrl: n.link?.url,
        impressionTrackers: imptrackers,
        assets,
        ortb: n
      };
    }
  } catch { /* ignore */
  }
}

/**
 * Ensure a valid VAST asset ("vastUrl" or "vastXml") is present on a PBJS video bid.
 *
 * Behavior:
 * - No-op for non-video bids.
 * - Sanitizes converter output:
 *   - trims and clears blank strings for "vastUrl"/"vastXml"
 *   - drops "vastXml" if it is not real inline VAST XML
 * - If a valid asset is already present after sanitization, it is kept as-is.
 * - Otherwise tries, in order:
 *   1) Use inline VAST found in "bid.adm" to set "resp.vastXml"
 *   2) Use "bid.nurl" to set "resp.vastUrl"
 *   3) Fabricate legacy delivery URL from "creativeId" (CRID/ID) and "params.supplyId"
 *      to set "resp.vastUrl"
 * - Never assigns empty strings; leaves "vastUrl"/"vastXml" undefined if nothing usable exists.
 *
 *   @param {Bid} resp            PBJS bid response being built.
 *   @param {Object} bid          Raw ORTB bid object (seatbid.bid[i]).
 *   @param {{ bidRequest?: BidRequest }} ctx    Converter context (contains the originating BidRequest).
 *   @returns {void}
 */
function ensureVideoAsset(resp, bid, ctx) {
  if (resp.mediaType !== VIDEO) {
    return;
  }

  // normalize blanks produced by the converter
  if (typeof resp.vastUrl === 'string' && !isNotBlank(resp.vastUrl)) {
    resp.vastUrl = undefined;
  }
  if (typeof resp.vastXml === 'string' && !isNotBlank(resp.vastXml)) {
    resp.vastXml = undefined;
  }

  // Clear vastXml if it's not actually inline VAST XML
  if (typeof resp.vastXml === 'string') {
    const xml = resp.vastXml.trim();
    if (!xml || !/^</.test(xml) || !/<VAST(\s|>)/i.test(xml)) {
      resp.vastXml = undefined;
    }
  }

  // if a non-empty asset already exists, keep it
  if (isNotBlank(resp.vastUrl) || isNotBlank(resp.vastXml)) {
    return;
  }

  const adm = (typeof bid.adm === 'string') ? bid.adm.trim() : '';

  // inline VAST in adm to vastXml
  if (adm && /^</.test(adm) && /<VAST(\s|>)/i.test(adm)) {
    resp.vastXml = adm;
    return;
  }

  // VAST URL in nurl map to vastUrl
  if (isNotBlank(bid.nurl)) {
    resp.vastUrl = bid.nurl;
    return;
  }

  // Fallback to legacy delivery URL
  const params = deepAccess(ctx, 'bidRequest.params') || {};
  const creativeId = bid.crid || bid.id;
  if (creativeId && params.supplyId) {
    resp.vastUrl = `${ENDPOINT}/d/${creativeId}/${params.supplyId}/?ts=${timestamp()}`;
  }
}

/**
 * Ensure that a banner bid has "width" and "height" on the PBJS response.
 *
 * Behavior:
 * - No-op for non-banner bids.
 * - Returns early if "resp.width" and "resp.height" are already present.
 * - Otherwise tries to derive a size from the originating ad unit:
 *   1) "bidRequest.mediaTypes.banner.sizes"
 *   2) legacy "bidRequest.sizes"
 * - Accepts either a single pair [w, h] or an array of pairs [[w, h], ...] and
 *   uses the first pair found.
 *
 * @param {Bid} resp   PBJS bid response being built.
 * @param {{ bidRequest?: BidRequest }} ctx  Converter context (only "bidRequest" is read).
 * @returns {void}
 */
function ensureBannerSize(resp, ctx) {
  if (resp.mediaType !== BANNER) {
    return;
  }
  if (resp.width && resp.height) {
    return;
  }

  const sizes = deepAccess(ctx, 'bidRequest.mediaTypes.banner.sizes') || deepAccess(ctx, 'bidRequest.sizes');
  const first = Array.isArray(sizes) && Array.isArray(sizes[0]) ? sizes[0] : sizes;
  if (Array.isArray(first) && first.length >= 2) {
    resp.width = first[0];
    resp.height = first[1];
  }
}

function isNotBlank(v) {
  return (typeof v === 'string') && v.trim().length > 0;
}

/**
 * Apply GDPR consent to ORTB.
 * Sets `regs.ext.gdpr` (0/1) and `user.consent` (2.6) + `user.ext.consent` (2.5 fallback).
 * No-op if consent info is absent.
 *
 * @param {Object} ortb
 * @param {Object} bidderReq
 * @returns {void}
 */
function applyConsent(ortb, bidderReq) {
  const gdpr = bidderReq?.gdprConsent;
  if (!gdpr) {
    return;
  }

  const applies = (typeof gdpr.gdprApplies === 'boolean') ? gdpr.gdprApplies : undefined;
  const consent = (typeof gdpr.consentString === 'string') ? gdpr.consentString : undefined;

  if (applies !== undefined) {
    ortb.regs = ortb.regs || {};
    ortb.regs.ext = ortb.regs.ext || {};
    ortb.regs.ext.gdpr = applies ? 1 : 0;
  }
  if (consent) {
    ortb.user = ortb.user || {};
    ortb.user.consent = consent;          // ORTB 2.6
    ortb.user.ext = ortb.user.ext || {};
    ortb.user.ext.consent = consent;      // ORTB 2.5 fallback
  }
}

/**
 * Apply user EIDs to ORTB.
 * Copies the first adunit’s `userIdAsEids` into `user.eids`.
 * No-op if none present.
 *
 * @param {Object} ortb
 * @param {BidRequest[]} bidRequests
 * @returns {void}
 */
function applyEids(ortb, bidRequests) {
  // take the first adunit that has eids
  const withEids = bidRequests.find(b => Array.isArray(b.userIdAsEids) && b.userIdAsEids.length);
  if (withEids) {
    ortb.user = ortb.user || {};
    ortb.user.eids = withEids.userIdAsEids;
  }
}

/**
 * Apply supply chain (schain) to ORTB.
 * Prefers `b.ortb2.source.ext.schain`; falls back to legacy `b.schain`.
 * Writes to `source.ext.schain`. No-op if unavailable.
 *
 * @param {Object} ortb
 * @param {BidRequest[]} bidRequests
 * @returns {void}
 */
function applySchain(ortb, bidRequests) {
  const holder = bidRequests.find(b => deepAccess(b, 'ortb2.source.ext.schain') || b.schain);
  const schain = deepAccess(holder, 'ortb2.source.ext.schain') || holder?.schain;
  if (!schain) {
    return;
  }
  ortb.source = ortb.source || {};
  ortb.source.ext = ortb.source.ext || {};
  ortb.source.ext.schain = schain;
}

/**
 * Apply per-impression fields.
 * For each bidRequest, finds matching `imp` by `id` and sets:
 * - `imp.tagid` from `params.adslotId` (when present).
 * No-op for missing matches.
 *
 * @param {Object} ortb
 * @param {BidRequest[]} bidRequests
 * @returns {void}
 */
function applyImps(ortb, bidRequests) {
  const imps = ortb.imp || [];
  bidRequests.forEach((br) => {
    const imp = imps.find(i => i && i.id === br.bidId);
    if (!imp) {
      return;
    }
    // tagid from params.adslotId
    if (br.params && br.params.adslotId != null) {
      imp.tagid = br.params.adslotId;
    }
  });
}

/**
 * Apply Price Floors per impression.
 * For each bidRequest with `getFloor()`, finds the matching ORTB `imp` by `id`
 * and sets `imp.bidfloor` (CPM in currency units) and `imp.bidfloorcur`.
 * Uses `derivePrimaryMediaType(bid)` and passes size as a single `[w,h]` when
 * exactly one banner size exists; otherwise uses `'*'`. No-ops when `getFloor`
 * is missing, currencies differ, the floor is non-finite, or no matching `imp`.
 *
 * @param {Object} ortb            OpenRTB request to mutate (`imp[]` is read/updated)
 * @param {BidRequest[]} bidRequests
 * @returns {void}
 */
function applyBidFloors(ortb, bidRequests) {
  const imps = ortb.imp || [];
  bidRequests.forEach((br) => {
    if (typeof br.getFloor !== 'function') {
      return;
    }
    const imp = imps.find(i => i && i.id === br.bidId);
    if (!imp) {
      return;
    }

    const mediaType = derivePrimaryMediaType(br);
    const sizes = extractSizePairs(br);
    const sizeArg = (sizes.length !== 1) ? '*' : sizes[0]; // [w,h] or '*'

    const floor = br.getFloor({
      currency: CURRENCY_CODE,
      mediaType: mediaType || '*',
      size: sizeArg
    });

    if (floor && floor.currency === CURRENCY_CODE && typeof floor.floor === 'number' && isFinite(floor.floor)) {
      imp.bidfloor = floor.floor;
      imp.bidfloorcur = CURRENCY_CODE;
    }
  });
}

/**
 * Merge page-provided IAB content into ORTB's site.content and app.content.
 *
 * - Chooses site.content vs app.content automatically
 * - Copies all fields from params.iabContent as-is
 * - Only alias applied: `live` -> `livestream`
 * - Ignores null/undefined values
 *
 *  @param {Object} ortb              The OpenRTB request object to mutate.
 *  @param {BidRequest[]} bidRequests Valid bid requests (to read params.iabContent from).
 *  @returns {void}
 */
function applyIabContent(ortb, bidRequests) {
  const holder = bidRequests.find(b => b?.params?.iabContent);
  const src = holder && holder.params.iabContent;
  if (!src || typeof src !== 'object') {
    return;
  }

  let parent;
  if (ortb.app) {
    ortb.app = ortb.app || {};
    parent = ortb.app;
  } else {
    ortb.site = ortb.site || {};
    parent = ortb.site;
  }

  parent.content = parent.content || {};
  const dst = parent.content;

  Object.entries(src).forEach(([k, v]) => {
    if (v == null) {
      return;
    }
    const key = (k === 'live') ? 'livestream' : k;
    dst[key] = v;
  });
}

/**
 * Attach Virtual Minds (vm) extension to request.ext.vm.
 * Merge order:
 *   1) Page-level FPD (bidderRequest.ortb2.ext.vm) is copied as-is.
 *   2) Adapter-derived fields overwrite (externalid, targeting).
 *
 * @param {Object} ortb - OpenRTB request to mutate
 * @param {Array} bidRequests - Per-adunit bid requests
 * @param {Object} bidderReq - Prebid bidderRequest (ortb2, refererInfo, auctionId, etc.)
 */
function applyVmExt(ortb, bidRequests, bidderReq) {
  const firstExtId = bidRequests.map(b => b.params?.extId).find(Boolean);
  const targetingObj = mergeKeyValues(bidRequests);
  const targeting = kvToQueryString(targetingObj);

  ortb.ext = ortb.ext || {};
  ortb.ext.vm = ortb.ext.vm || {};

  const vmPage = deepAccess(bidderReq, 'ortb2.ext.vm');
  if (vmPage && typeof vmPage === 'object') {
    Object.assign(ortb.ext.vm, vmPage);
  }

  if (firstExtId) {
    ortb.ext.vm.externalid = firstExtId;
  }
  if (targeting) {
    ortb.ext.vm.targeting = targeting;
  }
}

/**
 * Resolve the primary media type (priority: banner > video > native).
 *
 * @param {BidRequest} bid
 * @returns {'banner'|'video'|'native'|undefined} primary media type or undefined
 */
function derivePrimaryMediaType(bid) {
  const mt = bid.mediaTypes || {};
  if (mt.banner) {
    return 'banner';
  }
  if (mt.video) {
    return 'video';
  }
  if (mt.native) {
    return 'native';
  }
  return undefined;
}

/**
 * Extract banner sizes as unique [w,h] pairs.
 * Prefers `mediaTypes.banner.sizes`; falls back to legacy `sizes`.
 * Accepts `[w,h]` or `[[w,h], …]`, flattens and de-duplicates (order-preserving).
 * Ignores malformed entries. Video sizes are handled via `mediaTypes.video.playerSize`.
 *
 * @param {BidRequest} bid
 * @returns {Array<[number, number]>} de-duplicated array of `[width, height]` pairs
 */
function extractSizePairs(bid) {
  const { mediaTypes } = bid;
  const sizes = [];

  if (mediaTypes && mediaTypes.banner && Array.isArray(mediaTypes.banner.sizes)) {
    if (Array.isArray(mediaTypes.banner.sizes[0])) {
      sizes.push(...mediaTypes.banner.sizes);
    } else {
      sizes.push(mediaTypes.banner.sizes);
    }
  } else if (Array.isArray(bid.sizes)) {
    if (Array.isArray(bid.sizes[0])) {
      sizes.push(...bid.sizes);
    } else {
      sizes.push(bid.sizes);
    }
  }

  // dedupe
  const key = (p) => (Array.isArray(p) && p.length >= 2) ? (p[0] + DIMENSION_SIGN + p[1]) : '';
  const seen = new Set();
  const out = [];
  sizes.forEach((pair) => {
    const k = key(pair);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(pair);
    }
  });
  return out;
}

registerBidder(spec);

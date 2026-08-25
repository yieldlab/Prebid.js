import { expect } from 'chai';
import { spec } from 'modules/yieldlabBidAdapter.js';
import { newBidder } from 'src/adapters/bidderFactory.js';
import { isNativeOpenRTBBidValid, toLegacyResponse, toOrtbNativeRequest, toOrtbNativeResponse } from 'src/native.js';

import 'src/prebid.js';
import 'modules/currency.js';
import 'modules/userId/index.js';
import 'modules/multibid/index.js';
import 'modules/priceFloors.js';
import 'modules/consentManagementTcf.js';
import 'modules/consentManagementUsp.js';

import { hook } from 'src/hook.js';

const DEFAULT_REQUEST = () => ({
  bidder: 'yieldlab',
  params: {
    adslotId: '1111',
    supplyId: '2222',
    targeting: {
      key1: 'value1',
      key2: 'value2',
      notDoubleEncoded: 'value3,value4'
    },
    customParams: { extraParam: true, foo: 'bar' },
    extId: 'abc'
  },
  bidderRequestId: '143346cf0f1731',
  auctionId: '2e41f65424c87c',
  adUnitCode: 'adunit-code',
  bidId: '2d925f27f5079f',
  mediaTypes: {
    banner: { sizes: [[728, 90]] }
  },
  userIdAsEids: [{
    source: 'netid.de',
    uids: [{ id: 'fH5A3n2O8_CZZyPoJVD-eabc6ECb7jhxCicsds7qSg', atype: 1 }]
  }, {
    source: 'digitrust.de',
    uids: [{ id: 'd8aa10fa-d86c-451d-aad8-5f16162a9e64', atype: 2 }]
  }],
  schain: {
    ver: '1.0',
    complete: 1,
    nodes: [
      { asi: 'indirectseller.com', sid: '1', hp: 1 },
      { asi: 'indirectseller2.com', name: 'indirectseller2 name with comma , and bang !', sid: '2', hp: 1 }
    ]
  }
});

const VIDEO_REQUEST = () => ({
  ...DEFAULT_REQUEST(),
  mediaTypes: {
    video: {
      playerSize: [[640, 480]],
      context: 'outstream'
    }
  }
});

const NATIVE_REQUEST = () => ({
  ...DEFAULT_REQUEST(),
  mediaTypes: {
    native: {
      title: { required: true, len: 90 },
      body: { required: true },
      image: { required: true, sizes: [100, 100] },
      icon: { required: true, sizes: [16, 16] }
    }
  }
});

describe('yieldlabBidAdapter (ORTB)', () => {
  before(() => {
    hook.ready();
  });

  describe('instantiation', () => {
    it('creates a bidder instance', () => {
      const bidder = newBidder(spec);
      expect(bidder.callBids).to.be.a('function');
    });
  });

  describe('isBidRequestValid', () => {
    it('returns true for required params', () => {
      expect(spec.isBidRequestValid({
        params: { adslotId: '1', supplyId: '2' }
      })).to.equal(true);
    });

    it('returns false when required params are missing', () => {
      expect(spec.isBidRequestValid({})).to.equal(false);
    });
  });

  describe('buildRequests (POST /ortb)', () => {
    it('builds a POST with OpenRTB body and headers', () => {
      const bid = DEFAULT_REQUEST();
      const bidderRequest = {
        auctionId: 'auction-123',
        timeout: 700,
        refererInfo: { page: 'https://example.test/page', ref: 'https://ref.test/ref' },
        ortb2: {
          ext: { vm: { gp: true, foo: 'bar' } },
          source: { ext: { schain: bid.schain } },
          user: { ext: { eids: bid.userIdAsEids } }
        }
      };

      const req = spec.buildRequests([bid], bidderRequest);

      expect(req.method).to.equal('POST');
      expect(req.url).to.match(/\/ortb$/);
      expect(req.options).to.have.nested.property('contentType', 'application/json');
      expect(req.options).to.have.nested.property('customHeaders.x-openrtb-version', '2.6');

      const ortb = JSON.parse(req.data);

      // request basics
      expect(ortb.id).to.equal('auction-123');
      expect(ortb.tmax).to.equal(700);
      expect(ortb.cur).to.deep.equal(['EUR']);

      // site
      expect(ortb).to.have.property('site');
      expect(ortb.site.page).to.equal('https://example.test/page');
      expect(ortb.site.ref).to.equal('https://ref.test/ref');

      // imp[0]
      expect(ortb.imp).to.be.an('array').with.length(1);
      const imp = ortb.imp[0];
      expect(imp.id).to.equal(bid.bidId);
      expect(imp.tagid).to.equal('1111');

      // ext.vm (pass-through + additions)
      expect(ortb).to.have.nested.property('ext.vm');
      expect(ortb.ext.vm.gp).to.equal(true);
      expect(ortb.ext.vm.foo).to.equal('bar');
      expect(ortb.ext.vm.externalid).to.equal('abc');
      expect(ortb.ext.vm.targeting).to.equal('key1=value1&key2=value2&notDoubleEncoded=value3,value4');

      expect(ortb).to.have.nested.property('user.ext.eids').that.is.an('array').with.length(2);
      expect(ortb).to.have.nested.property('user.eids').that.is.an('array').with.length(2);

      expect(ortb).to.have.nested.property('source.ext.schain.ver', '1.0');
      expect(ortb).to.have.nested.property('source.schain.ver', '1.0');
    });

    it('returns no request at all when not a single imp could be built', () => {
      // An ORTB request without impressions is invalid, and the converter drops
      // any imp it fails to build - so the adapter leaves the auction instead.
      const req = spec.buildRequests([], { auctionId: 'no-imps', timeout: 300 });

      expect(req).to.deep.equal([]);
    });

    describe('applyIabContent', () => {
      it('copies fields to site.content, aliases live to livestream, ignores nulls, preserves unknown keys', () => {
        const bid = DEFAULT_REQUEST();
        bid.params.iabContent = {
          id: 'c-1',
          title: 'Episode Title',
          live: 1,
          keywords: 'foo,bar',
          customX: 'keep-me',
          nullable: null
        };

        const bidderRequest = {
          auctionId: 'auc-iab',
          timeout: 500,
          refererInfo: { page: 'https://p', ref: 'https://r' }
        };

        const req = spec.buildRequests([bid], bidderRequest);
        const ortb = JSON.parse(req.data);

        expect(ortb).to.have.nested.property('site.content');
        const content = ortb.site.content;
        expect(content.id).to.equal('c-1');
        expect(content.title).to.equal('Episode Title');
        expect(content.livestream).to.equal(1); // alias applied
        expect(content).to.have.property('keywords', 'foo,bar');
        expect(content).to.have.property('customX', 'keep-me');
        expect(content).to.not.have.property('nullable');
      });

      it('overwrites existing duplicate fields in content (by design)', () => {
        const bid = DEFAULT_REQUEST();
        bid.params.iabContent = { title: 'new-title' };

        const bidderRequest = {
          auctionId: 'auc-iab2',
          timeout: 300,
          refererInfo: { page: 'https://p', ref: 'https://r' },
          // pre-populate site.content via ortb2 to ensure we overwrite
          ortb2: { site: { content: { title: 'old-title', series: 'keep-series' } } }
        };

        const req = spec.buildRequests([bid], bidderRequest);
        const ortb = JSON.parse(req.data);

        expect(ortb).to.have.nested.property('site.content');
        expect(ortb.site.content.title).to.equal('new-title'); // overwritten
        expect(ortb.site.content.series).to.equal('keep-series'); // unrelated preserved
      });
    });

    describe('applyVmExt', () => {
      it('preserves unrelated FPD fields but overwrites externalid, targeting', () => {
        const bid = DEFAULT_REQUEST(); // extId = 'abc'
        // add some targeting to ensure encoding happens
        bid.params.targeting = { a: '1', b: '2' };

        const bidderRequest = {
          auctionId: 'auc-vm-1',
          timeout: 600,
          refererInfo: { page: 'https://p', ref: 'https://r' },
          ortb2: {
            ext: {
              vm: {
                gp: true,
                foo: 'bar',
                windowid: 'window-id',
                externalid: 'old-ext',
                targeting: 'old-target'
              }
            }
          }
        };

        const req = spec.buildRequests([bid], bidderRequest);
        const ortb = JSON.parse(req.data);

        expect(ortb).to.have.nested.property('ext.vm.gp', true);
        expect(ortb).to.have.nested.property('ext.vm.foo', 'bar');
        expect(ortb.ext.vm.windowid).to.equal('window-id');

        // overwritten by adapter
        expect(ortb.ext.vm.externalid).to.equal('abc');
        expect(ortb.ext.vm.targeting).to.equal('a=1&b=2');
      });
    });
  });

  describe('interpretResponse (banner)', () => {
    it('maps a standard ORTB banner bid', () => {
      const bid = DEFAULT_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'auction-123', timeout: 700 });
      const ortbReq = JSON.parse(req.data);

      const serverResponse = {
        body: {
          id: 'auction-123',
          seatbid: [{
            bid: [{
              impid: ortbReq.imp[0].id,
              price: 1.23,
              adm: '<div>banner creative</div>',
              crid: 'srv-1',
              dealid: 'deal-42',
              adomain: ['yieldlab']
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.be.an('array').with.length(1);
      const bidResponse = res[0];

      expect(bidResponse.mediaType).to.equal('banner');
      expect(bidResponse.cpm).to.equal(1.23);
      expect(bidResponse.width).to.equal(728);
      expect(bidResponse.height).to.equal(90);
      expect(bidResponse.creativeId).to.equal('srv-1');
      expect(bidResponse.dealId).to.equal('deal-42');
      expect(bidResponse.currency).to.equal('EUR');
      expect(bidResponse.netRevenue).to.equal(false);
      expect(bidResponse.ttl).to.equal(300);
      expect(bidResponse.ad).to.equal('<div>banner creative</div>');
      expect(bidResponse.meta.advertiserDomains).to.deep.equal(['yieldlab']);
    });

    it('sets advertiserDomains to ["n/a"] and passes through DSA when missing', () => {
      const bid = DEFAULT_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'auction-nodom', timeout: 300 });
      const ortbReq = JSON.parse(req.data);

      const serverResponse = {
        body: {
          id: 'auction-nodom',
          seatbid: [{
            bid: [{
              impid: ortbReq.imp[0].id,
              price: 0.5,
              adm: '<div>banner</div>',
              id: 'srv-2',
              // no adomain anywhere
              ext: { dsa: { foo: 'bar' } }
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.have.length(1);
      const bidResponse = res[0];

      expect(bidResponse.mediaType).to.equal('banner');
      expect(bidResponse.meta.advertiserDomains).to.deep.equal(['n/a']);
      expect(bidResponse.meta.dsa).to.deep.equal({ foo: 'bar' });
    });
  });

  describe('interpretResponse (video)', () => {
    it('installs outstream renderer and applies player size', () => {
      const bid = VIDEO_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'a' });
      const ortbReq = JSON.parse(req.data);

      const serverResponse = {
        body: {
          id: 'a',
          seatbid: [{
            bid: [{
              impid: ortbReq.imp[0].id,
              price: 2.0,
              // no mtype: adapter will deduce from bidRequest.mediaTypes.video
              adm: '<VAST version="3.0"></VAST>',
              w: 640,
              h: 480,
              adomain: ['yieldlab'],
              crid: 'v-1'
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.have.length(1);
      const bidResponse = res[0];

      expect(bidResponse.mediaType).to.equal('video');
      expect(bidResponse.width).to.equal(640);
      expect(bidResponse.height).to.equal(480);
      expect(bidResponse.renderer).to.exist;
      expect(bidResponse.renderer.id).to.equal(bid.bidId);
    });

    it('uses playerSize when server omits w/h', () => {
      const bid = VIDEO_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'a2' });
      const ortbReq = JSON.parse(req.data);

      const serverResponse = {
        body: {
          id: 'a2',
          seatbid: [{
            bid: [{
              impid: ortbReq.imp[0].id,
              price: 1.5,
              adm: '<VAST version="3.0"></VAST>',
              // w/h intentionally omitted
              adomain: ['yieldlab'],
              crid: 'v-2'
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.have.length(1);
      const bidResponse = res[0];

      expect(bidResponse.mediaType).to.equal('video');
      expect(bidResponse.width).to.equal(640); // from playerSize
      expect(bidResponse.height).to.equal(480); // from playerSize
    });

    describe('sanitizeVideoAsset', () => {
      it('only sanitizes converter output (clears blank strings)', () => {
        const bid = VIDEO_REQUEST();
        const req = spec.buildRequests([bid], { auctionId: 'vid-sanitize' });
        const ortbReq = JSON.parse(req.data);

        const serverResponse = {
          body: {
            id: 'vid-sanitize',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 1.0,
                adm: ' ',
                adomain: ['yieldlab']
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const bidResponse = res[0];
        expect(bidResponse.mediaType).to.equal('video');
        expect(bidResponse.vastUrl && bidResponse.vastUrl.trim()).to.be.undefined;
        expect(bidResponse.vastXml && bidResponse.vastXml.trim()).to.be.undefined;
      });
    });
  });

  describe('interpretResponse (native)', () => {
    if (FEATURES.NATIVE) {
      it('keeps native assets and trackers', () => {
        const bid = NATIVE_REQUEST();
        const req = spec.buildRequests([bid], { auctionId: 'a' });
        const ortbReq = JSON.parse(req.data);

        const nativeAdm = JSON.stringify({
          native: {
            link: { url: 'https://www.yieldlab.de' },
            assets: [
              { id: 1, title: { text: 'This is a great headline' } },
              { id: 2, img: { url: 'https://ad.yieldlab.net/yl-logo100x100.jpg', w: 100, h: 100 } },
              { id: 3, data: { value: 'Native body value' } },
              { id: 4, img: { url: 'https://ad.yieldlab.net/assets/favicon/favicon-16x16.png', w: 16, h: 16 } }
            ],
            imptrackers: ['https://tracker/1', 'https://tracker/2']
          }
        });

        const serverResponse = {
          body: {
            id: 'a',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 0.9,
                adm: nativeAdm,
                adomain: ['yieldlab'],
                crid: 'n-1'
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const bidResponse = res[0];

        expect(bidResponse.mediaType).to.equal('native');

        const nativeResponse = bidResponse.native.ortb;
        expect(nativeResponse).to.have.property('assets').that.is.an('array').with.length.greaterThan(0);

        const assetResponseTitle = nativeResponse.assets.find(a => a.title && a.title.text);
        const assetResponseData = nativeResponse.assets.find(a => a.data && typeof a.data.value === 'string');
        const assetResponseImages = nativeResponse.assets.filter(a => a.img && a.img.url);

        expect(assetResponseTitle?.title.text).to.equal('This is a great headline');
        expect(assetResponseData?.data.value).to.equal('Native body value');

        const hasLogo = assetResponseImages.some(i => i.img.url.includes('yl-logo100x100.jpg') && i.img.w === 100 && i.img.h === 100);
        const hasFavicon = assetResponseImages.some(i => i.img.url.includes('favicon-16x16.png') && i.img.w === 16 && i.img.h === 16);
        expect(hasLogo).to.equal(true);
        expect(hasFavicon).to.equal(true);

        expect(nativeResponse.imptrackers).to.deep.equal(['https://tracker/1', 'https://tracker/2']);
        expect(nativeResponse.link?.url).to.equal('https://www.yieldlab.de');
      });
    }
  });

  describe('native asset-id contract with the adserver native template', () => {
    if (FEATURES.NATIVE) {
      // The adserver DISCARDS imp.native.request and rebuilds the native request from the
      // adslot's native template (OpenRTBRequestGeneratorServiceImpl.getNativeRequest reads
      // only the template's assets). The DSP therefore answers with the TEMPLATE's asset ids,
      // and this adapter passes that ORTB straight through as bid.native.ortb. Prebid then
      // validates the response against the PUBLISHER's request, matching by asset id
      // (isNativeOpenRTBBidValid / toLegacyResponse), so the two only line up if the
      // publisher's config mirrors the Yieldlab template.
      //
      // Fixture below is stage native template 13: a single icon image asset with id 4.
      // (img.type 1 = ICON, 3 = MAIN, per NATIVE_IMAGE_TYPES in src/constants.)
      const TEMPLATE_IMAGE_URL = 'https://ad.yieldlab.net/qa/main.jpg';
      const TEMPLATE_13_ADM = JSON.stringify({
        native: {
          ver: '1.2',
          link: { url: 'https://ad.yieldlab.net/qa/click' },
          assets: [
            { id: 4, required: 0, img: { type: 1, url: TEMPLATE_IMAGE_URL, w: 300, h: 250 } }
          ],
          eventtrackers: [{ event: 1, method: 1, url: 'https://ad.yieldlab.net/1x1.gif' }]
        }
      });

      /** Run a bid request through buildRequests + interpretResponse against the template adm. */
      const interpretTemplateResponse = (bidRequest) => {
        const req = spec.buildRequests([bidRequest], { auctionId: 'nat-tpl' });
        const ortbReq = JSON.parse(req.data);
        const res = spec.interpretResponse({
          body: {
            id: 'nat-tpl',
            cur: 'EUR',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 1.0,
                adm: TEMPLATE_13_ADM,
                adomain: ['yieldlab'],
                crid: 'qa-native-crid'
              }]
            }]
          }
        }, req);
        expect(res).to.have.length(1);
        return res[0];
      };

      /** A publisher ad unit whose native config is the usual mediaTypes.native shorthand. */
      const shorthandRequest = () => {
        const bid = NATIVE_REQUEST();
        bid.nativeOrtbRequest = toOrtbNativeRequest(bid.mediaTypes.native);
        return bid;
      };

      it('passes the template asset ids through to bid.native.ortb untouched', () => {
        const bidResponse = interpretTemplateResponse(shorthandRequest());

        expect(bidResponse.mediaType).to.equal('native');
        expect(bidResponse.native.ortb.assets.map(asset => asset.id)).to.deep.equal([4]);
        expect(bidResponse.native.ortb.link.url).to.equal('https://ad.yieldlab.net/qa/click');
      });

      it('numbers publisher assets from 0, so the template id 4 is never among them', () => {
        const publisherRequest = toOrtbNativeRequest(NATIVE_REQUEST().mediaTypes.native);
        const ids = publisherRequest.assets.map(asset => asset.id);

        expect(ids[0]).to.equal(0);
        expect(ids).to.not.include(4);
        expect(publisherRequest.assets.some(asset => asset.required === 1)).to.equal(true);
      });

      it('CURRENT BEHAVIOUR (defective): the bid is rejected when the publisher config does not mirror the template', () => {
        const bid = shorthandRequest();
        const bidResponse = interpretTemplateResponse(bid);

        // Required ids 0..3 were asked for; only id 4 came back.
        expect(isNativeOpenRTBBidValid(bidResponse.native.ortb, bid.nativeOrtbRequest)).to.equal(false);
      });

      // ------------------------------------------------------------------
      // DESIRED BEHAVIOUR — currently FAILS. This is the bug, expressed as a
      // test. It should go green when native is fixed, wherever the fix lands:
      //   * adserver-side  — honour/intersect the incoming imp.native.request so
      //     the response already carries the publisher's asset ids; or
      //   * adapter-side   — reconcile the DSP's template-shaped assets onto the
      //     publisher's requested ids by facet type, which is what the legacy
      //     (pre-POST-ORTB) adapter effectively did via toOrtbNativeResponse.
      // Either fix satisfies this test, so it does not prejudge the design.
      // Delete the characterization tests above once this one passes.
      // ------------------------------------------------------------------
      it('a publisher using the standard mediaTypes.native shorthand gets a usable native bid', () => {
        const bid = shorthandRequest();
        const bidResponse = interpretTemplateResponse(bid);

        expect(isNativeOpenRTBBidValid(bidResponse.native.ortb, bid.nativeOrtbRequest)).to.equal(true);

        const legacy = toLegacyResponse(bidResponse.native.ortb, bid.nativeOrtbRequest);
        expect(legacy.image?.url).to.equal(TEMPLATE_IMAGE_URL);
      });

      it('ACCEPTS the bid when the publisher config mirrors the template asset ids', () => {
        const mirroredOrtb = {
          ver: '1.2',
          assets: [{ id: 4, required: 0, img: { type: 1, wmin: 100, hmin: 100 } }]
        };
        const bid = { ...DEFAULT_REQUEST(), mediaTypes: { native: { ortb: mirroredOrtb } } };
        bid.nativeOrtbRequest = mirroredOrtb;

        const bidResponse = interpretTemplateResponse(bid);

        expect(isNativeOpenRTBBidValid(bidResponse.native.ortb, bid.nativeOrtbRequest)).to.equal(true);
      });

      it('CURRENT BEHAVIOUR (defective): required:0 lets the id mismatch through, and the image is mis-filed as icon', () => {
        const bid = {
          ...DEFAULT_REQUEST(),
          mediaTypes: {
            native: {
              title: { required: false, len: 90 },
              body: { required: false },
              image: { required: false, sizes: [300, 250] }
            }
          }
        };
        bid.nativeOrtbRequest = toOrtbNativeRequest(bid.mediaTypes.native);

        const bidResponse = interpretTemplateResponse(bid);

        // Nothing is required, so the required-asset check cannot fail...
        expect(isNativeOpenRTBBidValid(bidResponse.native.ortb, bid.nativeOrtbRequest)).to.equal(true);

        // ...but the mapping is still by id, and id 4 matches nothing the publisher asked for,
        // so the creative's image is filed as `icon` and `image` is never populated.
        const legacy = toLegacyResponse(bidResponse.native.ortb, bid.nativeOrtbRequest);
        expect(legacy.icon?.url).to.equal(TEMPLATE_IMAGE_URL);
        expect(legacy.image).to.equal(undefined);
      });
    }
  });

  describe('applyNetRevenue', () => {
    it('sets bidResponse.netRevenue from bid.ext.netrevenue (true)', () => {
      const bid = DEFAULT_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'nr-1', timeout: 300 });
      const ortbReq = JSON.parse(req.data);

      const serverResponse = {
        body: {
          id: 'nr-1',
          seatbid: [{
            bid: [{
              impid: ortbReq.imp[0].id,
              price: 0.42,
              adm: '<div>banner creative</div>',
              crid: 'cr-1',
              adomain: ['yieldlab'],
              ext: { netrevenue: true }
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.have.length(1);
      const br = res[0];

      expect(br.mediaType).to.equal('banner');
      expect(br.netRevenue).to.equal(true);
      expect(br.cpm).to.equal(0.42);
      expect(br.creativeId).to.equal('cr-1');
      expect(br.currency).to.equal('EUR');
    });
  });

  describe('getUserSyncs', () => {
    const syncOptions = { iframeEnabled: true, pixelEnabled: false };

    it('returns iframe sync with GDPR fields', () => {
      const gdprConsent = { gdprApplies: true, consentString: 'CONSENT-STRING' };
      const syncs = spec.getUserSyncs(syncOptions, [], gdprConsent, '1YYY');
      expect(syncs).to.be.an('array').with.length(1);
      const sync = syncs[0];
      expect(sync.type).to.equal('iframe');
      expect(sync.url).to.match(/^https:\/\/ad.yieldlab.net\/d\/6846326\/766\/2x2\?/);
      expect(sync.url).to.include('type=h');
      expect(sync.url).to.include('gdpr=1');
      expect(sync.url).to.include('gdpr_consent=CONSENT-STRING');
      expect(sync.url).to.not.include('usp_consent');
      expect(sync.url).to.match(/ts=\d+/);
    });

    it('returns empty when iframe syncs are disabled', () => {
      const syncs = spec.getUserSyncs({ iframeEnabled: false, pixelEnabled: false }, [], null, null);
      expect(syncs).to.deep.equal([]);
    });

    it('omits both GDPR params when there is no consent data', () => {
      const syncs = spec.getUserSyncs(syncOptions, [], undefined, undefined);

      expect(syncs).to.be.an('array').with.length(1);
      expect(syncs[0].url).to.include('/d/6846326/766/2x2?');
      expect(syncs[0].url).to.include('type=h');
      expect(syncs[0].url).to.match(/ts=\d+/);
      expect(syncs[0].url).to.not.include('gdpr=');
      expect(syncs[0].url).to.not.include('gdpr_consent=');
    });

    it('sends gdpr=0 when gdprApplies is false', () => {
      const syncs = spec.getUserSyncs(syncOptions, [], { gdprApplies: false, consentString: 'CONSENT-0' }, null);

      expect(syncs).to.have.length(1);
      expect(syncs[0].url).to.include('gdpr=0');
      expect(syncs[0].url).to.include('gdpr_consent=CONSENT-0');
    });

    it('omits gdpr but keeps the consent string when gdprApplies is not a boolean', () => {
      const syncs = spec.getUserSyncs(syncOptions, [], { consentString: 'CONSENT-ONLY' }, null);

      expect(syncs).to.have.length(1);
      expect(syncs[0].url).to.not.include('gdpr=');
      expect(syncs[0].url).to.include('gdpr_consent=CONSENT-ONLY');
    });
  });

  describe('applies floors (impFn)', () => {
    it('sets bidfloor/bidfloorcur from getFloor (banner)', () => {
      const bid = DEFAULT_REQUEST();
      let lastArgs;
      bid.getFloor = (args) => {
        lastArgs = args;
        return { currency: 'EUR', floor: 1.1 };
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-bnr', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(lastArgs).to.deep.equal({ currency: 'EUR', mediaType: 'banner', size: [728, 90] });
      expect(ortb.imp[0].bidfloor).to.equal(1.1);
      expect(ortb.imp[0]).to.have.property('bidfloorcur', 'EUR');
    });

    it('sets bidfloor using "*" size for video (current behavior)', () => {
      const bid = VIDEO_REQUEST();
      let lastArgs;
      bid.getFloor = (args) => {
        lastArgs = args;
        return { currency: 'EUR', floor: 2.5 };
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-vid', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(lastArgs.mediaType).to.equal('video');
      expect(lastArgs.size).to.equal('*'); // matches current adapter logic
      expect(ortb.imp[0].bidfloor).to.equal(2.5);
      expect(ortb.imp[0]).to.have.property('bidfloorcur', 'EUR');
    });

    it('does not set bidfloor when getFloor currency mismatches', () => {
      const bid = DEFAULT_REQUEST();
      bid.getFloor = () => ({ currency: 'USD', floor: 3.3 });

      const req = spec.buildRequests([bid], { auctionId: 'flo-curr', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(ortb.imp[0]).to.not.have.property('bidfloor');
      expect(ortb.imp[0]).to.not.have.property('bidfloorcur');
    });

    it('deletes the floor the converter already set when the currency is not EUR', () => {
      const bid = DEFAULT_REQUEST();
      const calls = [];
      bid.getFloor = (args) => {
        calls.push(args);
        return { currency: 'USD', floor: 4.5 };
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-usd-delete', timeout: 300 });
      const ortb = JSON.parse(req.data);

      // The converter's own bidfloor processor asks first (with size '*'), so a USD
      // floor is on the imp by the time applyFloorToImp runs; it has to remove it
      // rather than let a USD number travel in a EUR-only request.
      expect(calls.length).to.be.greaterThan(1);
      expect(ortb.imp[0]).to.not.have.property('bidfloor');
      expect(ortb.imp[0]).to.not.have.property('bidfloorcur');
    });

    it('strips the non-EUR granular floors the price floors module scatters over the imp', () => {
      // setGranularBidfloors copies per-mediatype and per-format floors onto
      // imp[mediaType].ext and imp.banner.format[].ext whenever they differ from
      // the top level pair; deleting imp.bidfloor alone would leave them behind.
      const bid = DEFAULT_REQUEST();
      bid.mediaTypes.video = { playerSize: [[640, 480]], context: 'outstream', mimes: ['video/mp4'] };
      bid.getFloor = ({ mediaType, size }) => {
        if (Array.isArray(size)) return { currency: 'USD', floor: 7 };
        if (mediaType === 'banner') return { currency: 'USD', floor: 6 };
        if (mediaType === 'video') return { currency: 'USD', floor: 8 };
        return { currency: 'USD', floor: 5 };
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-granular-usd', timeout: 300 });
      const imp = JSON.parse(req.data).imp[0];

      expect(imp).to.not.have.property('bidfloor');
      expect(imp).to.not.have.property('bidfloorcur');
      expect(imp.banner).to.not.have.property('ext');
      (imp.banner.format || []).forEach((format) => {
        expect(format).to.not.have.property('ext');
      });
      if (imp.video) {
        expect(imp.video).to.not.have.property('ext');
      }
    });

    it('keeps granular floors that are already in EUR', () => {
      const bid = DEFAULT_REQUEST();
      bid.getFloor = ({ mediaType, size }) => {
        if (Array.isArray(size)) return { currency: 'EUR', floor: 7 };
        if (mediaType === 'banner') return { currency: 'EUR', floor: 6 };
        return { currency: 'EUR', floor: 5 };
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-granular-eur', timeout: 300 });
      const imp = JSON.parse(req.data).imp[0];

      expect(imp.bidfloor).to.equal(7);
      expect(imp).to.have.property('bidfloorcur', 'EUR');
      expect(imp.banner).to.have.nested.property('ext.bidfloor', 6);
      expect(imp.banner).to.have.nested.property('ext.bidfloorcur', 'EUR');
    });

    it('keeps the imp, unfloored, when getFloor throws', () => {
      // Publisher supplied floor code can throw (priceFloors calls
      // inverseBidAdjustment unguarded). Without a catch the converter drops the
      // whole imp and the request goes out with no impressions.
      const bid = DEFAULT_REQUEST();
      bid.getFloor = () => {
        throw new Error('floor provider exploded');
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-throws', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(ortb.imp).to.be.an('array').with.length(1);
      expect(ortb.imp[0].id).to.equal(bid.bidId);
      expect(ortb.imp[0].tagid).to.equal('1111');
      expect(ortb.imp[0]).to.not.have.property('bidfloor');
      expect(ortb.imp[0]).to.not.have.property('bidfloorcur');
    });

    it('passes "*" as size when the banner has more than one size', () => {
      const bid = DEFAULT_REQUEST();
      bid.mediaTypes.banner.sizes = [[728, 90], [800, 250]];
      let lastArgs;
      bid.getFloor = (args) => {
        lastArgs = args;
        return { currency: 'EUR', floor: 0.8 };
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-multisize', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(lastArgs).to.deep.equal({ currency: 'EUR', mediaType: 'banner', size: '*' });
      expect(ortb.imp[0].bidfloor).to.equal(0.8);
      expect(ortb.imp[0]).to.have.property('bidfloorcur', 'EUR');
    });

    it('prefers banner over video on a multiformat ad unit', () => {
      const bid = DEFAULT_REQUEST();
      bid.mediaTypes.video = { playerSize: [[640, 480]], context: 'outstream' };
      let lastArgs;
      bid.getFloor = (args) => {
        lastArgs = args;
        return { currency: 'EUR', floor: 1.7 };
      };

      const req = spec.buildRequests([bid], { auctionId: 'flo-multiformat', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(lastArgs.mediaType).to.equal('banner');
      expect(lastArgs.size).to.deep.equal([728, 90]);
      expect(ortb.imp[0].bidfloor).to.equal(1.7);
    });

    it('leaves the imp unfloored when the bid has no getFloor', () => {
      const bid = DEFAULT_REQUEST();
      expect(bid.getFloor).to.equal(undefined);

      const req = spec.buildRequests([bid], { auctionId: 'flo-nogetfloor', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(ortb.imp[0]).to.not.have.property('bidfloor');
      expect(ortb.imp[0]).to.not.have.property('bidfloorcur');
    });

    it('leaves the imp unfloored when getFloor answers with a non-finite floor', () => {
      const bid = DEFAULT_REQUEST();
      bid.getFloor = () => ({ currency: 'EUR', floor: undefined });

      const req = spec.buildRequests([bid], { auctionId: 'flo-nonfinite', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(ortb.imp[0]).to.not.have.property('bidfloor');
      expect(ortb.imp[0]).to.not.have.property('bidfloorcur');
    });

    it('forwards a zero floor, which the converter alone would have skipped', () => {
      const bid = DEFAULT_REQUEST();
      bid.getFloor = () => ({ currency: 'EUR', floor: 0 });

      const req = spec.buildRequests([bid], { auctionId: 'flo-zero', timeout: 300 });
      const ortb = JSON.parse(req.data);

      // applyFloorToImp gates on Number.isFinite, the converter's tryGetFloor on
      // truthiness - so a floor of exactly 0 only survives because of the adapter.
      expect(ortb.imp[0].bidfloor).to.equal(0);
      expect(ortb.imp[0]).to.have.property('bidfloorcur', 'EUR');
    });
  });

  describe('applyConsent', () => {
    it('mirrors 2.5 fields (regs.ext.gdpr=1, user.ext.consent) into 2.6 (regs.gdpr, user.consent)', () => {
      const bid = DEFAULT_REQUEST();
      const bidderRequest = {
        auctionId: 'gdpr-mirror-1',
        timeout: 400,
        ortb2: {
          regs: { ext: { gdpr: 1 } },
          user: { ext: { consent: 'CONSENT-STRING' } }
        }
      };

      const req = spec.buildRequests([bid], bidderRequest);
      const ortb = JSON.parse(req.data);

      // source (2.5) still present
      expect(ortb).to.have.nested.property('regs.ext.gdpr', 1);
      expect(ortb).to.have.nested.property('user.ext.consent', 'CONSENT-STRING');
      // mirrored (2.6)
      expect(ortb).to.have.nested.property('regs.gdpr', 1);
      expect(ortb).to.have.nested.property('user.consent', 'CONSENT-STRING');
    });

    it('mirrors when gdpr=0 and leaves consent absent if not provided', () => {
      const bid = DEFAULT_REQUEST();
      const bidderRequest = {
        auctionId: 'gdpr-mirror-0',
        timeout: 400,
        ortb2: {
          regs: { ext: { gdpr: 0 } }
          // no user.ext.consent
        }
      };

      const req = spec.buildRequests([bid], bidderRequest);
      const ortb = JSON.parse(req.data);

      expect(ortb).to.have.nested.property('regs.ext.gdpr', 0);
      expect(ortb).to.have.nested.property('regs.gdpr', 0);
      expect(ortb).to.not.have.nested.property('user.consent');
    });

    it('mirrors an empty consent string rather than dropping it', () => {
      const bid = DEFAULT_REQUEST();
      const bidderRequest = {
        auctionId: 'gdpr-empty-consent',
        timeout: 400,
        ortb2: {
          regs: { ext: { gdpr: 1 } },
          user: { ext: { consent: '' } }
        }
      };

      const req = spec.buildRequests([bid], bidderRequest);
      const ortb = JSON.parse(req.data);

      expect(ortb).to.have.nested.property('user.ext.consent', '');
      expect(ortb).to.have.nested.property('user.consent', '');
    });

    it('leaves both 2.6 fields absent when the page supplies no consent data', () => {
      const bid = DEFAULT_REQUEST();

      const req = spec.buildRequests([bid], { auctionId: 'gdpr-absent', timeout: 400 });
      const ortb = JSON.parse(req.data);

      expect(ortb).to.not.have.nested.property('regs.gdpr');
      expect(ortb).to.not.have.nested.property('user.consent');
    });
  });

  describe('multiple imps', () => {
    it('sets tagid per imp and merges VM targeting with later values overwriting earlier', () => {
      const bid1 = DEFAULT_REQUEST();
      bid1.params.adslotId = '1111';
      bid1.params.targeting = { k: '1' };

      const bid2 = DEFAULT_REQUEST();
      bid2.bidId = 'BID-2';
      bid2.params.adslotId = '2222';
      bid2.params.targeting = { k: '2', x: 'y' };

      const req = spec.buildRequests([bid1, bid2], { auctionId: 'multi', timeout: 300 });
      const ortb = JSON.parse(req.data);

      const imp1 = ortb.imp.find(i => i.id === bid1.bidId);
      const imp2 = ortb.imp.find(i => i.id === bid2.bidId);
      expect(imp1.tagid).to.equal('1111');
      expect(imp2.tagid).to.equal('2222');

      // mergeKeyValues + kvToQueryString: later overwrite, order preserved
      expect(ortb).to.have.nested.property('ext.vm.targeting', 'k=2&x=y');
    });
  });

  describe('applySchain', () => {
    it('mirrors source.ext.schain to source.schain', () => {
      const bid = DEFAULT_REQUEST();

      const bidderRequest = {
        auctionId: 'schain-fpd',
        timeout: 300,
        ortb2: { source: { ext: { schain: bid.schain } } }
      };

      const req = spec.buildRequests([bid], bidderRequest);
      const ortb = JSON.parse(req.data);

      expect(ortb).to.have.nested.property('source.ext.schain.ver', '1.0');
      expect(ortb).to.have.nested.property('source.schain.ver', '1.0');
    });

    it('mirrors the whole chain, nodes included', () => {
      const bid = DEFAULT_REQUEST();

      const req = spec.buildRequests([bid], {
        auctionId: 'schain-nodes',
        timeout: 300,
        ortb2: { source: { ext: { schain: bid.schain } } }
      });
      const ortb = JSON.parse(req.data);

      expect(ortb.source.schain).to.deep.equal(bid.schain);
      expect(ortb.source.schain.nodes).to.have.length(2);
      expect(ortb.source.schain.nodes[1].name).to.equal('indirectseller2 name with comma , and bang !');
    });

    it('leaves source.schain absent when the page provides no chain', () => {
      const bid = DEFAULT_REQUEST();

      const req = spec.buildRequests([bid], { auctionId: 'schain-none', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(ortb).to.not.have.nested.property('source.schain');
    });
  });

  describe('applyEids', () => {
    it('mirrors user.ext.eids to user.eids', () => {
      const bid = DEFAULT_REQUEST();

      const req = spec.buildRequests([bid], {
        auctionId: 'eids-mirror',
        timeout: 300,
        ortb2: { user: { ext: { eids: bid.userIdAsEids } } }
      });
      const ortb = JSON.parse(req.data);

      expect(ortb.user.ext.eids).to.deep.equal(bid.userIdAsEids);
      expect(ortb.user.eids).to.deep.equal(bid.userIdAsEids);
      expect(ortb.user.eids[0].source).to.equal('netid.de');
      expect(ortb.user.eids[1].uids[0].atype).to.equal(2);
    });

    it('leaves user.eids absent when the page provides no eids', () => {
      const bid = DEFAULT_REQUEST();

      const req = spec.buildRequests([bid], { auctionId: 'eids-none', timeout: 300 });
      const ortb = JSON.parse(req.data);

      expect(ortb).to.not.have.nested.property('user.eids');
    });
  });

  describe('dealId', () => {
    it('is left unset when the served bid carries no dealid', () => {
      const bid = DEFAULT_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'deal-none', timeout: 300 });
      const ortbReq = JSON.parse(req.data);

      const serverResponse = {
        body: {
          id: 'deal-none',
          seatbid: [{
            bid: [{
              impid: ortbReq.imp[0].id,
              price: 1.0,
              adm: '<div>banner creative</div>',
              crid: 'no-deal',
              adomain: ['yieldlab']
              // no dealid
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.have.length(1);
      expect(res[0]).to.not.have.property('dealId');
    });
  });
  describe('facet-type mapping as a candidate fix for the native id mismatch', () => {
    if (FEATURES.NATIVE) {
      // The legacy (pre-POST-ORTB) adapter matched the DSP's assets by FACET TYPE and emitted
      // legacy keys; Prebid then converted back via toOrtbNativeResponse, which clones the
      // PUBLISHER's requested asset and so stamps the publisher's id on. That is why legacy
      // never hit the id mismatch. These two tests pin what that approach does and does NOT fix.
      const legacyStyleFacetMap = (ortbAssets) => {
        const icon = ortbAssets.find(a => a.img && a.img.type === 1);
        const image = ortbAssets.find(a => a.img && a.img.type === 3);
        const title = ortbAssets.find(a => a.title);
        const body = ortbAssets.find(a => a.data);
        const out = { clickUrl: 'https://ad.yieldlab.net/qa/click' };
        if (title) out.title = title.title.text;
        if (body) out.body = body.data.value;
        if (image) out.image = { url: image.img.url, width: image.img.w, height: image.img.h };
        if (icon) out.icon = { url: icon.img.url, width: icon.img.w, height: icon.img.h };
        return out;
      };

      // Stage native template 13: exactly ONE asset, an icon image (img.type 1), id 4.
      const TPL_IMAGE_URL = 'https://ad.yieldlab.net/qa/main.jpg';
      const TEMPLATE_13_ASSETS = [
        { id: 4, img: { type: 1, url: TPL_IMAGE_URL, w: 300, h: 250 } }
      ];

      const validateVia = (publisherNativeCfg) => {
        const publisherRequest = toOrtbNativeRequest(publisherNativeCfg);
        const converted = toOrtbNativeResponse(legacyStyleFacetMap(TEMPLATE_13_ASSETS), publisherRequest);
        const withLink = { ...converted, link: { url: 'https://ad.yieldlab.net/qa/click' } };
        return {
          publisherRequest,
          converted,
          valid: isNativeOpenRTBBidValid(withLink, publisherRequest)
        };
      };

      it('FIXES the id mismatch when the template covers the facets the publisher asked for', () => {
        const { converted, valid } = validateVia({ icon: { required: true, sizes: [100, 100] } });

        // The template's id 4 has been rewritten to the publisher's own id 0.
        expect(converted.assets.map(a => a.id)).to.deep.equal([0]);
        expect(valid).to.equal(true);
      });

      it('does NOT help when the template lacks facets the publisher marked required', () => {
        const { publisherRequest, converted, valid } = validateVia(NATIVE_REQUEST().mediaTypes.native);

        // Publisher required title + body + image + icon; template 13 only has an icon, so only
        // the icon can be mapped. The bid is still rejected -- and rightly so: the missing assets
        // were never requested from the DSP. No response-side mapping can invent them.
        expect(publisherRequest.assets.filter(a => a.required === 1).map(a => a.id)).to.deep.equal([0, 1, 2, 3]);
        expect(converted.assets.map(a => a.id)).to.deep.equal([3]);
        expect(valid).to.equal(false);
      });
    }
  });
});

import { expect } from 'chai';
import { spec } from 'modules/yieldlabBidAdapter.js';
import { newBidder } from 'src/adapters/bidderFactory.js';

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
        ortb2: { ext: { vm: { gp: true, foo: 'bar' } } }
      };

      const req = spec.buildRequests([bid], bidderRequest);

      expect(req.method).to.equal('POST');
      expect(req.url).to.match(/\/ortb$/);
      expect(req.options).to.have.property('withCredentials', true);
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
      expect(imp).to.have.nested.property('ext.prebid.bidder.yieldlab');
      expect(imp.ext.prebid.bidder.yieldlab).to.deep.include({
        adslotId: '1111', supplyId: '2222', extId: 'abc'
      });
      expect(imp.ext.prebid.bidder.yieldlab).to.have.property('targeting');
      expect(imp.ext.prebid.bidder.yieldlab).to.have.property('customParams');

      // ext.vm (pass-through + additions)
      expect(ortb).to.have.nested.property('ext.vm');
      // pass-through from ortb2.ext.vm
      expect(ortb.ext.vm.gp).to.equal(true);
      expect(ortb.ext.vm.foo).to.equal('bar');
      // additions by adapter
      expect(ortb.ext.vm.windowid).to.equal('auction-123');
      expect(ortb.ext.vm.externalid).to.equal('abc');

      // targeting encoded
      const expectedRaw = 'key1=value1&key2=value2&notDoubleEncoded=value3,value4';
      expect(ortb.ext.vm.targeting).to.equal(encodeURIComponent(expectedRaw));

      // user.eids & source.schain (mapped by converter)
      expect(ortb).to.have.nested.property('user.eids').that.is.an('array').with.length(2);
      expect(ortb).to.have.nested.property('source.schain.ver', '1.0');
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
      it('preserves unrelated FPD fields but overwrites windowid, externalid, targeting', () => {
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
                windowid: 'old-window',
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

        // overwritten by adapter
        expect(ortb.ext.vm.windowid).to.equal('auc-vm-1');
        expect(ortb.ext.vm.externalid).to.equal('abc');
        expect(ortb.ext.vm.targeting).to.equal(encodeURIComponent('a=1&b=2'));
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
              // omit crid to exercise creativeId fallback via id
              id: 'srv-1',
              dealid: 'deal-42',
              adomain: ['yieldlab']
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.be.an('array').with.length(1);
      const b = res[0];

      expect(b.mediaType).to.equal('banner');
      expect(b.cpm).to.equal(1.23);
      expect(b.width).to.equal(728);
      expect(b.height).to.equal(90);
      expect(b.creativeId).to.equal('srv-1'); // fallback chain (id)
      expect(b.dealId).to.equal('deal-42'); // mapped from dealid
      expect(b.currency).to.equal('EUR');
      expect(b.netRevenue).to.equal(false);
      expect(b.ttl).to.equal(300);
      expect(b.ad).to.equal('<div>banner creative</div>');
      expect(b.meta.advertiserDomains).to.deep.equal(['yieldlab']);
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
      const b = res[0];

      expect(b.mediaType).to.equal('banner');
      expect(b.meta.advertiserDomains).to.deep.equal(['n/a']);
      expect(b.meta.dsa).to.deep.equal({ foo: 'bar' });
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
      const b = res[0];

      expect(b.mediaType).to.equal('video');
      expect(b.width).to.equal(640);
      expect(b.height).to.equal(480);
      expect(b.renderer).to.exist;
      expect(b.renderer.id).to.equal(bid.bidId);
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
      const b = res[0];

      expect(b.mediaType).to.equal('video');
      expect(b.width).to.equal(640); // from playerSize
      expect(b.height).to.equal(480); // from playerSize
    });

    describe('ensureVideoAsset', () => {
      it('uses inline VAST from adm when present', () => {
        const bid = VIDEO_REQUEST();
        const req = spec.buildRequests([bid], { auctionId: 'vid-xml' });
        const ortbReq = JSON.parse(req.data);

        const inlineVast = '<VAST version="3.0"><Ad></Ad></VAST>';
        const serverResponse = {
          body: {
            id: 'vid-xml',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 1.1,
                adm: inlineVast,
                w: 640,
                h: 480,
                adomain: ['yieldlab'],
                crid: 'v-xml-1'
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const b = res[0];

        expect(b.mediaType).to.equal('video');
        expect(b.vastXml).to.equal(inlineVast);
        expect(b).to.not.have.property('vastUrl');
      });

      it('falls back to nurl when provided', () => {
        const bid = VIDEO_REQUEST();
        const req = spec.buildRequests([bid], { auctionId: 'vid-nurl' });
        const ortbReq = JSON.parse(req.data);

        const nurl = 'https://vast.example.com/tag.xml';
        const serverResponse = {
          body: {
            id: 'vid-nurl',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 1.2,
                adm: '', // not VAST XML
                nurl,
                w: 640,
                h: 480,
                adomain: ['yieldlab'],
                crid: 'v-nurl-1'
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const b = res[0];

        expect(b.mediaType).to.equal('video');
        expect(b.vastUrl).to.equal(nurl);
        expect(b).to.not.have.property('vastXml');
      });

      it('does not override an existing non-empty vastUrl (idempotent)', () => {
        const bid = VIDEO_REQUEST();
        const req = spec.buildRequests([bid], { auctionId: 'vid-nourride' });
        const ortbReq = JSON.parse(req.data);

        // provide a good nurl so converter/adapter sets vastUrl, then ensure no fabrication happens
        const nurl = 'https://vast.example.com/already-there.xml';
        const serverResponse = {
          body: {
            id: 'vid-nourride',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 1.25,
                adm: '', // not VAST
                nurl,
                adomain: ['yieldlab'],
                crid: 'v-idem-1'
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const b = res[0];

        expect(b.mediaType).to.equal('video');
        expect(b.vastUrl).to.equal(nurl); // untouched
        expect(b).to.not.have.property('vastXml');
      });

      it('fabricates vastUrl from crid + supplyId when needed', () => {
        const bid = VIDEO_REQUEST();
        const req = spec.buildRequests([bid], { auctionId: 'vid-fab' });
        const ortbReq = JSON.parse(req.data);

        const crid = 'v-99';
        const serverResponse = {
          body: {
            id: 'vid-fab',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 1.3,
                // no adm VAST, no nurl -> should fabricate
                adomain: ['yieldlab'],
                crid
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const b = res[0];

        expect(b.mediaType).to.equal('video');
        expect(b).to.have.property('vastUrl');
        expect(b.vastUrl).to.match(new RegExp(`^https://ad.yieldlab.net/d/${crid}/2222/\\?ts=\\d+$`));
        expect(b).to.not.have.property('vastXml');
      });

      it('sanitizes non-VAST vastXml or blank strings from the converter', () => {
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
                adm: 'not xml', // ortb converter applies this to vastXml
                // no nurl, no ids to fabricate
                adomain: ['yieldlab']
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const b = res[0];

        expect(b.mediaType).to.equal('video');
        // after sanitization, they should be absent or blank
        expect(b.vastUrl && b.vastUrl.trim()).to.be.oneOf([undefined, '']);
        expect(b.vastXml && b.vastXml.trim()).to.be.oneOf([undefined, '']);
      });

      it('ignores non-video bids', () => {
        const bid = DEFAULT_REQUEST(); // banner
        const req = spec.buildRequests([bid], { auctionId: 'non-video' });
        const ortbReq = JSON.parse(req.data);

        const serverResponse = {
          body: {
            id: 'non-video',
            seatbid: [{
              bid: [{
                impid: ortbReq.imp[0].id,
                price: 0.5,
                adm: '<div>banner</div>',
                adomain: ['yieldlab'],
                crid: 'bn-1'
              }]
            }],
            cur: 'EUR'
          }
        };

        const res = spec.interpretResponse(serverResponse, req);
        expect(res).to.have.length(1);
        const b = res[0];

        expect(b.mediaType).to.equal('banner');
        expect(b).to.not.have.property('vastUrl');
        expect(b).to.not.have.property('vastXml');
      });
    });
  });

  describe('interpretResponse (native)', () => {
    it('adds convenience icon/image from assets', () => {
      const bid = NATIVE_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'a' });
      const ortbReq = JSON.parse(req.data);

      const nativeAdm = JSON.stringify({
        native: {
          link: { url: 'https://www.yieldlab.de' },
          assets: [
            { id: 1, title: { text: 'This is a great headline' } },
            { id: 2, img: { url: 'https://ad.yieldlab.net/yl-logo100x100.jpg', w: 100, h: 100, type: 3 } },
            { id: 3, data: { value: 'Native body value' } },
            { id: 4, img: { url: 'https://ad.yieldlab.net/assets/favicon/favicon-16x16.png', w: 16, h: 16, type: 1 } }
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
      const b = res[0];

      expect(b.mediaType).to.equal('native');
      expect(b.native.title).to.equal('This is a great headline');
      expect(b.native.body).to.equal('Native body value');
      expect(b.native.image).to.deep.equal({
        url: 'https://ad.yieldlab.net/yl-logo100x100.jpg', width: 100, height: 100
      });
      expect(b.native.icon).to.deep.equal({
        url: 'https://ad.yieldlab.net/assets/favicon/favicon-16x16.png', width: 16, height: 16
      });
      expect(b.native.clickUrl).to.equal('https://www.yieldlab.de');
      expect(b.native.impressionTrackers).to.have.length(2);
    });

    it('parses raw native adm object (no {native: …} wrapper)', () => {
      const bid = NATIVE_REQUEST();
      const req = spec.buildRequests([bid], { auctionId: 'raw-n' });
      const ortbReq = JSON.parse(req.data);

      const rawNative = JSON.stringify({
        link: { url: 'https://example.org' },
        assets: [
          { id: 10, title: { text: 'Raw Headline' } },
          { id: 11, data: { value: 'Raw Body' } }
        ],
        imptrackers: ['https://t1', 'https://t2']
      });

      const serverResponse = {
        body: {
          id: 'raw-n',
          seatbid: [{
            bid: [{
              impid: ortbReq.imp[0].id,
              price: 0.7,
              adm: rawNative,
              adomain: ['yieldlab'],
              crid: 'n-raw-1'
            }]
          }],
          cur: 'EUR'
        }
      };

      const res = spec.interpretResponse(serverResponse, req);
      expect(res).to.have.length(1);
      const b = res[0];

      expect(b.mediaType).to.equal('native');
      expect(b.native.title).to.equal('Raw Headline');
      expect(b.native.body).to.equal('Raw Body');
      expect(b.native.clickUrl).to.equal('https://example.org');
      expect(b.native.impressionTrackers).to.deep.equal(['https://t1', 'https://t2']);
    });
  });

  describe('getUserSyncs', () => {
    const syncOptions = { iframeEnabled: true, pixelEnabled: false };

    it('returns iframe sync with GDPR fields', () => {
      const gdprConsent = { gdprApplies: true, consentString: 'CONSENT-STRING' };
      const syncs = spec.getUserSyncs(syncOptions, [], gdprConsent, '1YYY');
      expect(syncs).to.be.an('array').with.length(1);
      const s = syncs[0];
      expect(s.type).to.equal('iframe');
      expect(s.url).to.match(/^https:\/\/ad.yieldlab.net\/d\/6846326\/766\/2x2\?/);
      expect(s.url).to.include('type=h');
      expect(s.url).to.include('gdpr=1');
      expect(s.url).to.include('gdpr_consent=CONSENT-STRING');
      expect(s.url).to.not.include('usp_consent');
      expect(s.url).to.match(/ts=\d+/);
    });

    it('returns empty when iframe syncs are disabled', () => {
      const syncs = spec.getUserSyncs({ iframeEnabled: false, pixelEnabled: false }, [], null, null);
      expect(syncs).to.deep.equal([]);
    });
  });
});

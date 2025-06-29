require('dotenv').config();
const express = require('express');
const { body, validationResult } = require('express-validator');
const adsSdk = require('facebook-nodejs-business-sdk');
const path = require('path');

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Initialize Facebook SDK
const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
const adAccountId = process.env.AD_ACCOUNT_ID;
const api = adsSdk.FacebookAdsApi.init(accessToken);
api.setDebug(true);

// SDK Models
const AdAccount = adsSdk.AdAccount;
const Campaign = adsSdk.Campaign;
const AdSet = adsSdk.AdSet;
const AdCreative = adsSdk.AdCreative;
const Ad = adsSdk.Ad;

// Retry logic for API calls
const retryRequest = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Create ad endpoint
app.post('/create-ad', [
  body('campaignName').notEmpty().trim().escape(),
  body('adSetName').notEmpty().trim().escape(),
  body('adName').notEmpty().trim().escape(),
  body('creativeTitle').notEmpty().trim().escape(),
  body('creativeBody').notEmpty().trim().escape(),
  body('pageId').notEmpty().isString()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const {
    campaignName,
    adSetName,
    adName,
    creativeTitle,
    creativeBody,
    pageId
  } = req.body;

  try {
    // 1. Create Campaign - Using LINK_CLICKS objective for simplicity
    const campaign = await retryRequest(() => 
      new AdAccount(adAccountId).createCampaign(['id', 'name'], {
        name: campaignName,
        objective: 'LINK_CLICKS', // Simple and reliable objective
        status: 'PAUSED',
        special_ad_categories: ['NONE'],
        access_token: accessToken
      })
    );

    // 2. Create Ad Set - Matching optimization goal
    const adSet = await retryRequest(() =>
      new AdAccount(adAccountId).createAdSet(['id', 'name'], {
        name: adSetName,
        campaign_id: campaign.id,
        daily_budget: '1000', // In cents ($10)
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS', // Must match campaign objective
        bid_amount: '100', // In cents ($1)
        targeting: {
          geo_locations: { countries: ['US'] },
          age_min: 18,
          age_max: 65,
          publisher_platforms: ['facebook'],
          facebook_positions: ['feed']
        },
        status: 'PAUSED',
        access_token: accessToken
      })
    );

    // 3. Create Creative
    const creative = await retryRequest(() =>
      new AdAccount(adAccountId).createAdCreative(['id', 'name'], {
        name: creativeTitle,
        object_story_spec: {
          page_id: pageId,
          link_data: {
            link: 'https://www.example.com', // Change to your URL
            message: creativeBody,
            name: creativeTitle,
            call_to_action: { type: 'LEARN_MORE' }
          }
        },
        access_token: accessToken
      })
    );

    // 4. Create Ad
    const ad = await retryRequest(() =>
      new AdAccount(adAccountId).createAd(['id', 'name'], {
        name: adName,
        adset_id: adSet.id,
        creative: { creative_id: creative.id },
        status: 'PAUSED',
        access_token: accessToken
      })
    );

    res.json({
      success: true,
      campaignId: campaign.id,
      adSetId: adSet.id,
      creativeId: creative.id,
      adId: ad.id
    });

  } catch (error) {
    console.error('Full API Error:', {
      message: error.message,
      request: error.config?.data,
      response: error.response?.data,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Ad creation failed',
      details: error.response?.data?.error || error.message,
      fbtrace_id: error.response?.data?.fbtrace_id
    });
  }
});

// Serve HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
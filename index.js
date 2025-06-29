require('dotenv').config();
const express = require('express');
const { body, validationResult } = require('express-validator');
const adsSdk = require('facebook-nodejs-business-sdk');
const path = require('path');
const fetch = require('node-fetch');

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
if (!accessToken || !adAccountId) {
  console.error('Missing FACEBOOK_ACCESS_TOKEN or AD_ACCOUNT_ID in .env');
  process.exit(1);
}

const api = adsSdk.FacebookAdsApi.init(accessToken);
api.setApiVersion('v18.0'); // Use the latest API version
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
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Upload image to get image_hash
const uploadImage = async (imageUrl) => {
  console.log('Uploading image...');
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${adAccountId}/adimages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: imageUrl
        })
      }
    );
    const data = await response.json();
    if (data.error) {
      throw new Error(`Image upload failed: ${JSON.stringify(data.error)}`);
    }
    const imageHash = data.images?.[Object.keys(data.images)[0]]?.hash;
    if (!imageHash) {
      throw new Error('No image hash returned from upload');
    }
    console.log('Image uploaded, hash:', imageHash);
    return imageHash;
  } catch (error) {
    throw new Error(`Image upload error: ${error.message}`);
  }
};

// Create ad endpoint
app.post('/create-ad', [
  body('campaignName').notEmpty().trim().escape(),
  body('adSetName').notEmpty().trim().escape(),
  body('adName').notEmpty().trim().escape(),
  body('creativeTitle').notEmpty().trim().escape(),
  body('creativeBody').notEmpty().trim().escape(),
  body('pageId').notEmpty().isString(),
  body('link').isURL().withMessage('Invalid URL'),
  body('imageUrl').isURL().withMessage('Invalid image URL')
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
    pageId,
    link,
    imageUrl
  } = req.body;

  console.log('Request body:', req.body);

  try {
    // Validate adAccountId format
    if (!adAccountId.startsWith('act_')) {
      throw new Error('Invalid adAccountId format. Must start with "act_"');
    }

    // 1. Upload Image
    console.log('Uploading image...');
    const imageHash = await uploadImage(imageUrl);

    // 2. Create Campaign
    console.log('Creating campaign...');
    const campaign = await retryRequest(() =>
      new AdAccount(adAccountId).createCampaign(
        ['id', 'name'],
        {
          name: campaignName,
          objective: 'OUTCOME_TRAFFIC',
          status: 'PAUSED',
          special_ad_categories: [],
          access_token: accessToken
        }
      )
    );
    console.log('Campaign created:', campaign.id);

    // 3. Create Ad Set
    console.log('Creating ad set...');
    const adSet = await retryRequest(() =>
      new AdAccount(adAccountId).createAdSet(
        ['id', 'name'],
        {
          name: adSetName,
          campaign_id: campaign.id,
          daily_budget: 1000, // $10.00 in cents
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'LINK_CLICKS',
          bid_amount: 100, // $1.00 in cents (integer)
          targeting: {
            geo_locations: { countries: ['US'] },
            age_min: 18,
            age_max: 65,
            publisher_platforms: ['facebook'],
            facebook_positions: ['feed']
          },
          status: 'PAUSED',
          access_token: accessToken
        }
      )
    );
    console.log('Ad set created:', adSet.id);

    // 4. Create Creative
    console.log('Creating creative...');
    const creative = await retryRequest(() =>
      new AdAccount(adAccountId).createAdCreative(
        ['id', 'name'],
        {
          name: creativeTitle,
          object_story_spec: {
            page_id: pageId,
            link_data: {
              link: link,
              message: creativeBody,
              name: creativeTitle,
              description: 'Learn more about our product!',
              call_to_action: { type: 'LEARN_MORE' },
              image_hash: imageHash
            }
          },
          degrees_of_freedom_spec: {
            creative_features_spec: {
              standard_enhancements: { enroll: true }
            }
          },
          access_token: accessToken
        }
      )
    );
    console.log('Creative created:', creative.id);

    // 5. Create Ad
    console.log('Creating ad...');
    const ad = await retryRequest(() =>
      new AdAccount(adAccountId).createAd(
        ['id', 'name'],
        {
          name: adName,
          adset_id: adSet.id,
          creative: { creative_id: creative.id },
          status: 'PAUSED',
          access_token: accessToken
        }
      )
    );
    console.log('Ad created:', ad.id);

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
      response: error.response?.data || error.stack,
      request: error.request?._data
    });
    res.status(500).json({
      error: 'Ad creation failed',
      details: error.response?.data?.error?.message || error.message,
      fbtrace_id: error.response?.data?.error?.fbtrace_id
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
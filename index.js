const express = require('express');
const bodyParser = require('body-parser');
const adsSdk = require('facebook-nodejs-business-sdk');
const dotenv = require('dotenv');
const { body, validationResult } = require('express-validator');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(express.json());

// Initialize Facebook Ads API (no setAppSecretProof needed)
const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
const appSecret = process.env.APP_SECRET;
adsSdk.FacebookAdsApi.init(accessToken, undefined, appSecret); // App secret proof is handled internally

// Models from SDK
const AdAccount = adsSdk.AdAccount;
const Campaign = adsSdk.Campaign;
const AdSet = adsSdk.AdSet;
const AdCreative = adsSdk.AdCreative;
const Ad = adsSdk.Ad;

// Retry logic
const retryRequest = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.code === 17 && i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
};

// Serve HTML form
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Handle form submission
app.post('/create-ad', [
  body('campaignName').notEmpty().trim().withMessage('Campaign name is required'),
  body('adSetName').notEmpty().trim().withMessage('Ad set name is required'),
  body('adName').notEmpty().trim().withMessage('Ad name is required'),
  body('creativeTitle').notEmpty().trim().withMessage('Creative title is required'),
  body('creativeBody').notEmpty().trim().withMessage('Creative body is required'),
  body('pageId').isNumeric().withMessage('Page ID must be numeric'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { campaignName, adSetName, adName, creativeTitle, creativeBody, pageId } = req.body;
    const adAccountId = process.env.AD_ACCOUNT_ID;

    // Step 1: Create Campaign
    const account = new AdAccount(adAccountId);
    const campaign = await retryRequest(() => account.createCampaign(
  [Campaign.Fields.Id, Campaign.Fields.Name],
  {
    [Campaign.Fields.Name]: campaignName,
    [Campaign.Fields.Objective]: 'LEAD_GENERATION',
    [Campaign.Fields.Status]: 'PAUSED',
    special_ad_categories: [] // ✅ Required field — even if empty
  }
));

    const campaignId = campaign.id;
    console.log('Campaign created with ID:', campaignId);

    // Step 2: Create Ad Set
    const adSet = await retryRequest(() => account.createAdSet(
      [AdSet.Fields.Id, AdSet.Fields.Name],
      {
        [AdSet.Fields.Name]: adSetName,
        [AdSet.Fields.CampaignId]: campaignId,
        [AdSet.Fields.DailyBudget]: 1000, // $10.00 (in cents)
        [AdSet.Fields.BillingEvent]: 'IMPRESSIONS',
        [AdSet.Fields.OptimizationGoal]: 'LEAD_GENERATION',
        [AdSet.Fields.BidAmount]: 100, // $1.00 (in cents)
        [AdSet.Fields.Targeting]: {
          geo_locations: { countries: ['US'] },
          age_min: 18,
          age_max: 65,
        },
        [AdSet.Fields.Status]: 'PAUSED',
      }
    ));
    const adSetId = adSet.id;
    console.log('Ad Set created with ID:', adSetId);

    // Step 3: Create Ad Creative
    const adCreative = await retryRequest(() => account.createAdCreative(
      [AdCreative.Fields.Id, AdCreative.Fields.Name],
      {
        [AdCreative.Fields.Name]: creativeTitle,
        [AdCreative.Fields.ObjectStorySpec]: {
          page_id: pageId,
          link_data: {
            link: 'https://www.example.com',
            message: creativeBody,
            name: creativeTitle,
            description: 'Get 20% off your first purchase!',
            call_to_action: { type: 'LEARN_MORE' },
          },
        },
      }
    ));
    const adCreativeId = adCreative.id;
    console.log('Ad Creative created with ID:', adCreativeId);

    // Step 4: Create Ad
    const ad = await retryRequest(() => account.createAd(
      [Ad.Fields.Id, Ad.Fields.Name],
      {
        [Ad.Fields.Name]: adName,
        [Ad.Fields.AdsetId]: adSetId,
        [Ad.Fields.Creative]: { creative_id: adCreativeId },
        [Ad.Fields.Status]: 'PAUSED',
      }
    ));
    console.log('Ad created with ID:', ad.id);

    res.json({ message: `Ad created successfully! Campaign ID: ${campaignId}, Ad ID: ${ad.id}` });
  } catch (error) {
    console.error('Error creating ad:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

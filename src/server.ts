import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { FormController } from './controllers/form.controller';  // ADD THIS

import { AuthController } from './controllers/auth.controller';
import { MappingController } from './controllers/mapping.controller';
import { WebhookController } from './controllers/webhook.controller';
import { SyncController } from './controllers/sync.controller';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.text());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100
});
app.use('/api/', limiter);

// Initialize controllers
const authController = new AuthController();
const mappingController = new MappingController();
const webhookController = new WebhookController();
const syncController = new SyncController();
const formController = new FormController();  // ADD THIS

// ============================================================
// AUTH ROUTES
// ============================================================
app.get('/auth/hubspot', authController.initiateHubSpotAuth);
app.get('/auth/hubspot/callback', authController.handleHubSpotCallback);
app.get('/auth/hubspot/disconnect/:instanceId', authController.disconnectHubSpot);
app.get('/auth/status/:instanceId', authController.getConnectionStatus);

// OAuth redirect pages
app.get('/auth/success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Success!</title>
        <style>
          body {
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 2rem;
            background: rgba(255,255,255,0.1);
            border-radius: 1rem;
            backdrop-filter: blur(10px);
          }
          .icon { font-size: 4rem; margin-bottom: 1rem; }
          h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
          .countdown { margin-top: 1rem; font-size: 0.875rem; opacity: 0.8; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">✓</div>
          <h1>Connected Successfully!</h1>
          <p>Your HubSpot account is now connected.</p>
        </div>
        <script>
          if (window.opener) window.opener.postMessage('hubspot-connected', '*');
          let seconds = 2;
          const interval = setInterval(() => {
            seconds--;
            document.getElementById('countdown').textContent = seconds;
            if (seconds <= 0) { clearInterval(interval); window.close(); }
          }, 1000);
        </script>
      </body>
    </html>
  `);
});

app.get('/auth/error', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Error</title>
        <style>
          body {
            font-family: system-ui, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 2rem;
            background: rgba(255,255,255,0.1);
            border-radius: 1rem;
            backdrop-filter: blur(10px);
          }
          .icon { font-size: 4rem; margin-bottom: 1rem; }
          h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
          button {
            margin-top: 1.5rem;
            padding: 0.5rem 1rem;
            background: white;
            border: none;
            border-radius: 0.25rem;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">✗</div>
          <h1>Connection Failed</h1>
          <p>Please try again.</p>
          <button onclick="window.close()">Close</button>
        </div>
        <script>
          if (window.opener) window.opener.postMessage('hubspot-error', '*');
        </script>
      </body>
    </html>
  `);
});

// ============================================================
// FIELD MAPPING ROUTES
// ============================================================
app.get('/api/mapping/:instanceId', mappingController.getFieldMapping);
app.put('/api/mapping/:instanceId', mappingController.updateFieldMapping);
app.get('/api/mapping/fields/:instanceId', mappingController.getAvailableFields);
app.get('/api/fields', mappingController.getAvailableFields);

// ============================================================
// SYNC LOGS & MONITORING ROUTES
// ============================================================
app.get('/api/sync/logs/:instanceId', syncController.getSyncLogs);
app.get('/api/sync/logs/detail/:logId', syncController.getSyncLogById);
app.get('/api/sync/contact/:instanceId/:contactId', syncController.getContactSyncHistory);
app.get('/api/sync/status/:instanceId', syncController.getSyncStatus);
app.get('/api/sync/failed/:instanceId', syncController.getFailedSyncs);
app.delete('/api/sync/logs/clear/:instanceId', syncController.clearOldSyncLogs);

// ============================================================
// MANUAL SYNC OPERATIONS
// ============================================================
app.post('/api/sync/wix-to-hubspot/:instanceId', syncController.manualSyncWixToHubSpot);
app.post('/api/sync/hubspot-to-wix/:instanceId', syncController.manualSyncHubSpotToWix);
app.post('/api/sync/bulk/:instanceId', syncController.bulkSync);
app.post('/api/sync/retry/:logId', syncController.retryFailedSync);

// ============================================================
// WEBHOOK ROUTES
// ============================================================
app.post('/webhook/wix/contact-created', webhookController.handleWixWebhook);
app.post('/webhook/wix/contact-updated', webhookController.handleWixWebhook);
app.post('/webhook/wix/form-submitted', webhookController.handleWixWebhook);
app.post('/webhooks/hubspot/contact', webhookController.handleHubSpotWebhook);

// ============================================================
// HEALTH CHECK
// ============================================================


app.get('/api/forms/submissions/:instanceId', formController.getFormSubmissions);
app.get('/api/forms/submissions/detail/:submissionId', formController.getFormSubmissionById);
app.get('/api/forms/stats/:instanceId', formController.getFormStats);
app.put('/api/forms/submissions/:submissionId/status', formController.updateLeadStatus);


app.get('/health', (req, res) => {
  console.log("hello world");
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`\n📋 Sync Logs API: http://localhost:${PORT}/api/sync/logs/:instanceId`);
  console.log(`📊 Sync Status API: http://localhost:${PORT}/api/sync/status/:instanceId`);
  console.log(`🗺️ Field Mapping API: http://localhost:${PORT}/api/mapping/:instanceId`);
});

export default app;
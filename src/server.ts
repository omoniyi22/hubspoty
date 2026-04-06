import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { AuthController } from './controllers/auth.controller';
import { MappingController } from './controllers/mapping.controller';
import { WebhookController } from './controllers/webhook.controller';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
// app.use(express.text());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Initialize controllers
const authController = new AuthController();
const mappingController = new MappingController();
const webhookController = new WebhookController();

// Auth routes
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

// Field mapping routes
app.get('/api/mapping/:instanceId', mappingController.getFieldMapping);
app.put('/api/mapping/:instanceId', mappingController.updateFieldMapping);
app.get('/api/fields', mappingController.getAvailableFields);

// Wix webhook endpoints
app.post('/webhook/wix/contact-created', webhookController.handleWixWebhook);
app.post('/webhook/wix/contact-updated', webhookController.handleWixWebhook);
app.post('/webhook/wix/form-submitted', webhookController.handleWixFormSubmitted);

// HubSpot webhook endpoint
app.post('/webhooks/hubspot/contact', webhookController.handleHubSpotWebhook);

// Health check
app.get('/health', (req, res) => {
  console.log("hello world")
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
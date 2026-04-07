"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const axios_1 = __importDefault(require("axios"));
const database_1 = require("../config/database");
const hubspot_service_1 = require("../services/hubspot.service");
const mapping_service_1 = require("../services/mapping.service");
class AuthController {
    constructor() {
        this.hubspotService = hubspot_service_1.HubSpotService.getInstance();
        this.mappingService = mapping_service_1.MappingService.getInstance();
        this.initiateHubSpotAuth = (req, res) => {
            const wixInstanceId = req.query.instance_id;
            console.log('Initiating HubSpot auth for instance:', wixInstanceId);
            if (!wixInstanceId) {
                console.warn('Missing instance_id in auth initiation');
                return res.status(400).json({ error: 'Missing instance_id' });
            }
            const authUrl = `https://app.hubspot.com/oauth/authorize?` +
                `client_id=${process.env.HUBSPOT_CLIENT_ID}` +
                `&redirect_uri=${encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI)}` +
                `&scope=crm.objects.contacts.write+crm.schemas.contacts.write+external_integrations.forms.access+oauth+forms-uploaded-files+forms+crm.schemas.contacts.read+crm.objects.contacts.read` +
                `&state=${wixInstanceId}`;
            console.log('Redirecting user to HubSpot auth URL');
            res.redirect(authUrl);
        };
        this.handleHubSpotCallback = async (req, res) => {
            const { code, state: wixInstanceId } = req.query;
            console.log('HubSpot callback received for instance:', wixInstanceId);
            if (!code || !wixInstanceId) {
                console.warn('Missing code or state in HubSpot callback');
                return res.redirect(`/auth/error?error=missing_params&error_description=${encodeURIComponent('Missing code or state parameter')}`);
            }
            try {
                console.log('Exchanging code for HubSpot tokens...');
                const params = new URLSearchParams();
                params.append('grant_type', 'authorization_code');
                params.append('client_id', process.env.HUBSPOT_CLIENT_ID);
                params.append('client_secret', process.env.HUBSPOT_CLIENT_SECRET);
                params.append('redirect_uri', process.env.HUBSPOT_REDIRECT_URI);
                params.append('code', code);
                const response = await axios_1.default.post('https://api.hubapi.com/oauth/v3/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                const tokenData = response.data;
                console.log('Received token data for portal:', tokenData.hub_id);
                const scope = tokenData.scope || 'crm.objects.contacts.read crm.objects.contacts.write';
                const connection = await database_1.prisma.hubSpotConnection.upsert({
                    where: { wixInstanceId: wixInstanceId },
                    update: {
                        hubSpotPortalId: tokenData.hub_id.toString(),
                        accessToken: tokenData.access_token,
                        refreshToken: tokenData.refresh_token,
                        expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
                        scope: scope,
                        isConnected: true
                    },
                    create: {
                        wixInstanceId: wixInstanceId,
                        hubSpotPortalId: tokenData.hub_id.toString(),
                        accessToken: tokenData.access_token,
                        refreshToken: tokenData.refresh_token,
                        expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
                        scope: scope,
                        isConnected: true
                    }
                });
                console.log('HubSpot connection stored in DB with ID:', connection.id);
                // Initialize default field mappings for this connection
                await this.mappingService.initializeDefaultMappings(connection.id);
                console.log('Default field mappings initialized');
                try {
                    console.log('Subscribing to HubSpot webhooks...');
                    await this.hubspotService.subscribeToWebhooks(connection.id, tokenData.hub_id.toString());
                    console.log('Webhook subscription complete');
                }
                catch (webhookError) {
                    console.warn('Webhook subscription failed - configure manually in HubSpot dashboard');
                }
                console.log('Redirecting to success page');
                res.redirect(`/auth/success?instance_id=${wixInstanceId}`);
            }
            catch (error) {
                console.error('OAuth callback error:', error);
                let errorMessage = 'Failed to complete OAuth flow';
                if (error.response?.data?.message) {
                    errorMessage = error.response.data.message;
                }
                else if (error.message) {
                    errorMessage = error.message;
                }
                res.redirect(`/auth/error?error=oauth_failed&error_description=${encodeURIComponent(errorMessage)}`);
            }
        };
        this.disconnectHubSpot = async (req, res) => {
            const { instanceId } = req.params;
            console.log('Disconnecting HubSpot for instance:', instanceId);
            try {
                await database_1.prisma.hubSpotConnection.update({
                    where: { wixInstanceId: instanceId },
                    data: { isConnected: false }
                });
                console.log('HubSpot disconnected successfully');
                res.json({ success: true });
            }
            catch (error) {
                console.error('Failed to disconnect HubSpot:', error);
                res.status(500).json({ error: 'Failed to disconnect' });
            }
        };
        this.getConnectionStatus = async (req, res) => {
            const { instanceId } = req.params;
            console.log('Fetching HubSpot connection status for instance:', instanceId);
            const connection = await database_1.prisma.hubSpotConnection.findUnique({
                where: { wixInstanceId: instanceId },
                include: { fieldMapping: true }
            });
            if (!connection || !connection.isConnected) {
                console.log('No active HubSpot connection found');
                return res.json({ connected: false });
            }
            console.log('HubSpot connection is active for portal:', connection.hubSpotPortalId);
            res.json({
                connected: true,
                portalId: connection.hubSpotPortalId,
                mapping: connection.fieldMapping?.mappings || null
            });
        };
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=auth.controller.js.map
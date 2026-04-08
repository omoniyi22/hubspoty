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
            const authUrl = `https://app-eu1.hubspot.com/oauth/authorize?` +
                `client_id=${process.env.HUBSPOT_CLIENT_ID}` +
                `&redirect_uri=${encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI)}` +
                `&scope=${encodeURIComponent('crm.objects.contacts.write crm.schemas.contacts.write external_integrations.forms.access oauth forms-uploaded-files forms crm.schemas.contacts.read crm.objects.contacts.read')}` +
                `&state=${wixInstanceId}`;
            console.log('Redirecting user to HubSpot auth URL:', authUrl);
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
                const scope = tokenData.scope || 'crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write external_integrations.forms.access oauth forms-uploaded-files forms';
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
                if (error.response?.data) {
                    console.error('OAuth error details:', JSON.stringify(error.response.data, null, 2));
                }
                res.redirect(`/auth/error?error=oauth_failed&error_description=${encodeURIComponent(errorMessage)}`);
            }
        };
        this.disconnectHubSpot = async (req, res) => {
            const { instanceId } = req.params;
            console.log('Disconnecting HubSpot for instance:', instanceId);
            try {
                const connection = await database_1.prisma.hubSpotConnection.findUnique({
                    where: { wixInstanceId: instanceId }
                });
                if (connection && connection.accessToken) {
                    try {
                        await axios_1.default.post('https://api.hubapi.com/oauth/v3/revoke', new URLSearchParams({
                            token: connection.accessToken
                        }), {
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Authorization': `Bearer ${connection.accessToken}`
                            }
                        });
                        console.log('HubSpot token revoked successfully');
                    }
                    catch (revokeError) {
                        console.warn('Failed to revoke token (may already be invalid):', revokeError);
                    }
                }
                await database_1.prisma.hubSpotConnection.update({
                    where: { wixInstanceId: instanceId },
                    data: {
                        isConnected: false,
                        accessToken: "",
                        refreshToken: "",
                        expiresAt: new Date(0)
                    }
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
            try {
                const connection = await database_1.prisma.hubSpotConnection.findUnique({
                    where: { wixInstanceId: instanceId },
                    include: { fieldMapping: true }
                });
                if (!connection || !connection.isConnected) {
                    console.log('No active HubSpot connection found');
                    return res.json({ connected: false });
                }
                // Check if token is expired or about to expire (within 5 minutes)
                const fiveMinutes = 5 * 60 * 1000;
                const isExpiringSoon = connection.expiresAt && new Date().getTime() >= connection.expiresAt.getTime() - fiveMinutes;
                if (isExpiringSoon) {
                    console.log('Token expiring soon, attempting to refresh...');
                    try {
                        const refreshed = await this.refreshAccessToken(connection.id, connection.refreshToken);
                        if (refreshed) {
                            const updatedConnection = await database_1.prisma.hubSpotConnection.findUnique({
                                where: { wixInstanceId: instanceId },
                                include: { fieldMapping: true }
                            });
                            if (updatedConnection) {
                                return res.json({
                                    connected: true,
                                    portalId: updatedConnection.hubSpotPortalId,
                                    mapping: updatedConnection.fieldMapping?.mappings || null
                                });
                            }
                        }
                        else {
                            // Refresh failed - mark as disconnected and require re-auth
                            await database_1.prisma.hubSpotConnection.update({
                                where: { wixInstanceId: instanceId },
                                data: { isConnected: false }
                            });
                            return res.json({
                                connected: false,
                                error: 'Token expired. Please re-authorize HubSpot connection.'
                            });
                        }
                    }
                    catch (refreshError) {
                        console.error('Token refresh failed:', refreshError);
                        await database_1.prisma.hubSpotConnection.update({
                            where: { wixInstanceId: instanceId },
                            data: { isConnected: false }
                        });
                        return res.json({
                            connected: false,
                            error: 'Token refresh failed. Please re-authorize HubSpot connection.'
                        });
                    }
                }
                console.log('HubSpot connection is active for portal:', connection.hubSpotPortalId);
                res.json({
                    connected: true,
                    portalId: connection.hubSpotPortalId,
                    mapping: connection.fieldMapping?.mappings || null,
                    scope: connection.scope
                });
            }
            catch (error) {
                console.error('Error checking connection status:', error);
                res.status(500).json({ error: 'Failed to check connection status' });
            }
        };
        this.refreshAccessToken = async (connectionId, refreshToken) => {
            try {
                console.log('Refreshing HubSpot access token...');
                const params = new URLSearchParams();
                params.append('grant_type', 'refresh_token');
                params.append('client_id', process.env.HUBSPOT_CLIENT_ID);
                params.append('client_secret', process.env.HUBSPOT_CLIENT_SECRET);
                params.append('refresh_token', refreshToken);
                const response = await axios_1.default.post('https://api.hubapi.com/oauth/v3/token', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                const tokenData = response.data;
                await database_1.prisma.hubSpotConnection.update({
                    where: { id: connectionId },
                    data: {
                        accessToken: tokenData.access_token,
                        refreshToken: tokenData.refresh_token || refreshToken,
                        expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
                        isConnected: true
                    }
                });
                console.log('Access token refreshed successfully');
                return true;
            }
            catch (error) {
                console.error('Failed to refresh access token:', error.message);
                // Check if it's a client mismatch error
                if (error.message?.includes('refresh token was not issued to this client')) {
                    console.error('⚠️ Client ID/Secret mismatch detected. User must re-authorize.');
                    // Mark connection as disconnected
                    await database_1.prisma.hubSpotConnection.update({
                        where: { id: connectionId },
                        data: { isConnected: false }
                    });
                }
                return false;
            }
        };
        // Add this new endpoint to check token health
        this.checkTokenHealth = async (req, res) => {
            const { instanceId } = req.params;
            try {
                const connection = await database_1.prisma.hubSpotConnection.findFirst({
                    where: { wixInstanceId: instanceId, isConnected: true }
                });
                if (!connection) {
                    return res.json({ healthy: false, reason: 'No active connection found' });
                }
                // Try to refresh token
                try {
                    const hubspotService = hubspot_service_1.HubSpotService.getInstance();
                    await hubspotService.getAccessToken(connection.id);
                    return res.json({ healthy: true });
                }
                catch (error) {
                    if (error.message?.includes('refresh token was not issued to this client')) {
                        // Mark as disconnected
                        await database_1.prisma.hubSpotConnection.update({
                            where: { id: connection.id },
                            data: { isConnected: false }
                        });
                        return res.json({
                            healthy: false,
                            reason: 'Token invalid. Please re-authorize HubSpot connection.'
                        });
                    }
                    return res.json({ healthy: false, reason: error.message });
                }
            }
            catch (error) {
                console.error('Error checking token health:', error);
                res.status(500).json({ error: 'Failed to check token health' });
            }
        };
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=auth.controller.js.map
import { Request, Response } from 'express';
import axios from 'axios';
import { prisma } from '../config/database';
import { HubSpotService } from '../services/hubspot.service';
import { MappingService } from '../services/mapping.service';
import { HubSpotTokenData } from '../types';

export class AuthController {
  private hubspotService = HubSpotService.getInstance();
  private mappingService = MappingService.getInstance();

  initiateHubSpotAuth = (req: Request, res: Response) => {
    const wixInstanceId = req.query.instance_id as string;
    console.log('Initiating HubSpot auth for instance:', wixInstanceId);

    if (!wixInstanceId) {
      console.warn('Missing instance_id in auth initiation');
      return res.status(400).json({ error: 'Missing instance_id' });
    }

    const authUrl =
      `https://app-eu1.hubspot.com/oauth/authorize?` +
      `client_id=${process.env.HUBSPOT_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI!)}` +
      `&scope=${encodeURIComponent('crm.objects.contacts.write crm.schemas.contacts.write external_integrations.forms.access oauth forms-uploaded-files forms crm.schemas.contacts.read crm.objects.contacts.read')}` +
      `&state=${wixInstanceId}`;

    console.log('Redirecting user to HubSpot auth URL:', authUrl);
    res.redirect(authUrl);
  };

  handleHubSpotCallback = async (req: Request, res: Response) => {
    const { code, state: wixInstanceId } = req.query;
    console.log('HubSpot callback received for instance:', wixInstanceId);

    if (!code || !wixInstanceId) {
      console.warn('Missing code or state in HubSpot callback');
      return res.redirect(
        `/auth/error?error=missing_params&error_description=${encodeURIComponent('Missing code or state parameter')}`
      );
    }

    try {
      console.log('Exchanging code for HubSpot tokens...');

      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('client_id', process.env.HUBSPOT_CLIENT_ID!);
      params.append('client_secret', process.env.HUBSPOT_CLIENT_SECRET!);
      params.append('redirect_uri', process.env.HUBSPOT_REDIRECT_URI!);
      params.append('code', code as string);

      const response = await axios.post(
        'https://api.hubapi.com/oauth/v3/token',
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const tokenData: HubSpotTokenData = response.data;
      console.log('Received token data for portal:', tokenData.hub_id);

      const scope = tokenData.scope || 'crm.objects.contacts.read crm.objects.contacts.write crm.schemas.contacts.read crm.schemas.contacts.write external_integrations.forms.access oauth forms-uploaded-files forms';

      const connection = await prisma.hubSpotConnection.upsert({
        where: { wixInstanceId: wixInstanceId as string },
        update: {
          hubSpotPortalId: tokenData.hub_id.toString(),
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
          scope: scope,
          isConnected: true
        },
        create: {
          wixInstanceId: wixInstanceId as string,
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
      } catch (webhookError) {
        console.warn('Webhook subscription failed - configure manually in HubSpot dashboard');
      }

      console.log('Redirecting to success page');
      res.redirect(`/auth/success?instance_id=${wixInstanceId}`);

    } catch (error: any) {
      console.error('OAuth callback error:', error);

      let errorMessage = 'Failed to complete OAuth flow';
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error.message) {
        errorMessage = error.message;
      }

      if (error.response?.data) {
        console.error('OAuth error details:', JSON.stringify(error.response.data, null, 2));
      }

      res.redirect(
        `/auth/error?error=oauth_failed&error_description=${encodeURIComponent(errorMessage)}`
      );
    }
  };

  disconnectHubSpot = async (req: Request, res: Response) => {
    const { instanceId } = req.params;
    console.log('Disconnecting HubSpot for instance:', instanceId);

    try {
      const connection = await prisma.hubSpotConnection.findUnique({
        where: { wixInstanceId: instanceId }
      });

      if (connection && connection.accessToken) {
        try {
          await axios.post(
            'https://api.hubapi.com/oauth/v3/revoke',
            new URLSearchParams({
              token: connection.accessToken
            }),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Bearer ${connection.accessToken}`
              }
            }
          );
          console.log('HubSpot token revoked successfully');
        } catch (revokeError) {
          console.warn('Failed to revoke token (may already be invalid):', revokeError);
        }
      }

      // FIX 1 & 2 & 3: Use Prisma's unset operation instead of null
      await prisma.hubSpotConnection.update({
        where: { wixInstanceId: instanceId },
        data: { 
          isConnected: false,
          accessToken: "",  // Changed from null to empty string
          refreshToken: "",  // Changed from null to empty string
          expiresAt: new Date(0)  // Changed from null to a past date
        }
      });

      console.log('HubSpot disconnected successfully');
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to disconnect HubSpot:', error);
      res.status(500).json({ error: 'Failed to disconnect' });
    }
  };

  getConnectionStatus = async (req: Request, res: Response) => {
    const { instanceId } = req.params;
    console.log('Fetching HubSpot connection status for instance:', instanceId);

    try {
      const connection = await prisma.hubSpotConnection.findUnique({
        where: { wixInstanceId: instanceId },
        include: { fieldMapping: true }
      });

      if (!connection || !connection.isConnected) {
        console.log('No active HubSpot connection found');
        return res.json({ connected: false });
      }

      if (connection.expiresAt && new Date() >= connection.expiresAt) {
        console.log('Token expired, attempting to refresh...');
        try {
          // FIX 4: Convert connection.id to string if needed, but Prisma already expects string
          // The error was because connectionId was typed as number but should be string
          // Since connection.id is already a string (cuid), we pass it directly
          const refreshed = await this.refreshAccessToken(connection.id, connection.refreshToken!);
          if (refreshed) {
            const updatedConnection = await prisma.hubSpotConnection.findUnique({
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
        } catch (refreshError) {
          console.error('Token refresh failed:', refreshError);
          return res.json({ connected: false, error: 'Token expired and refresh failed' });
        }
      }

      console.log('HubSpot connection is active for portal:', connection.hubSpotPortalId);
      res.json({
        connected: true,
        portalId: connection.hubSpotPortalId,
        mapping: connection.fieldMapping?.mappings || null,
        scope: connection.scope
      });
    } catch (error) {
      console.error('Error checking connection status:', error);
      res.status(500).json({ error: 'Failed to check connection status' });
    }
  };

  // FIX 5: Change connectionId type from number to string (since Prisma uses cuid strings)
  private refreshAccessToken = async (connectionId: string, refreshToken: string): Promise<boolean> => {
    try {
      console.log('Refreshing HubSpot access token...');
      
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('client_id', process.env.HUBSPOT_CLIENT_ID!);
      params.append('client_secret', process.env.HUBSPOT_CLIENT_SECRET!);
      params.append('refresh_token', refreshToken);

      const response = await axios.post(
        'https://api.hubapi.com/oauth/v3/token',
        params,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const tokenData: HubSpotTokenData = response.data;

      await prisma.hubSpotConnection.update({
        where: { id: connectionId },
        data: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || refreshToken,
          expiresAt: new Date(Date.now() + tokenData.expires_in * 1000)
        }
      });

      console.log('Access token refreshed successfully');
      return true;
    } catch (error) {
      console.error('Failed to refresh access token:', error);
      return false;
    }
  };
}
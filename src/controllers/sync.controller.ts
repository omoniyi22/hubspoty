import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { SyncService } from '../services/sync.service';
import { HubSpotService } from '../services/hubspot.service';
import { WixService } from '../services/wix.service';
import { v4 as uuidv4 } from 'uuid';

export class SyncController {
  private syncService = SyncService.getInstance();
  private hubspotService = HubSpotService.getInstance();
  private wixService = WixService.getInstance();

  // ─────────────────────────────────────────────
  // SYNC LOGS - For UI Display
  // ─────────────────────────────────────────────

  /**
   * Get sync logs for a specific instance with pagination and filtering
   * GET /api/sync/logs/:instanceId
   */
  getSyncLogs = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { 
        page = 1, 
        limit = 50, 
        status, 
        direction, 
        syncType,
        startDate,
        endDate 
      } = req.query;

      // First, find the connection
      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active connection found for this instance' 
        });
      }

      // Build filter conditions
      const where: any = { connectionId: connection.id };
      
      if (status) where.status = status;
      if (direction) where.direction = direction;
      if (syncType) where.syncType = syncType;
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = new Date(startDate as string);
        if (endDate) where.createdAt.lte = new Date(endDate as string);
      }

      // Get total count for pagination
      const total = await prisma.syncLog.count({ where });

      // Get paginated logs
      const logs = await prisma.syncLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      });

      // Get summary statistics
      const stats = await prisma.syncLog.groupBy({
        by: ['status', 'direction'],
        where: { connectionId: connection.id },
        _count: true,
      });

      res.json({
        success: true,
        data: {
          logs,
          pagination: {
            page: Number(page),
            limit: Number(limit),
            total,
            totalPages: Math.ceil(total / Number(limit)),
          },
          stats: {
            total: total,
            byStatus: stats.filter(s => s.status).reduce((acc, curr) => {
              acc[curr.status] = curr._count;
              return acc;
            }, {} as Record<string, number>),
            byDirection: stats.filter(s => s.direction).reduce((acc, curr) => {
              acc[curr.direction] = curr._count;
              return acc;
            }, {} as Record<string, number>),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching sync logs:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch sync logs' 
      });
    }
  };

  /**
   * Get a specific sync log by ID
   * GET /api/sync/logs/detail/:logId
   */
  getSyncLogById = async (req: Request, res: Response) => {
    try {
      const { logId } = req.params;

      const log = await prisma.syncLog.findUnique({
        where: { id: logId },
        include: {
          connection: {
            select: {
              wixInstanceId: true,
              hubSpotPortalId: true,
            },
          },
        },
      });

      if (!log) {
        return res.status(404).json({ 
          success: false, 
          error: 'Sync log not found' 
        });
      }

      res.json({ success: true, data: log });
    } catch (error) {
      console.error('Error fetching sync log:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch sync log' 
      });
    }
  };

  /**
   * Get sync logs for a specific contact
   * GET /api/sync/contact/:instanceId/:contactId
   */
  getContactSyncHistory = async (req: Request, res: Response) => {
    try {
      const { instanceId, contactId } = req.params;
      const { type = 'wix' } = req.query; // 'wix' or 'hubspot'

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active connection found' 
        });
      }

      // Build where clause based on contact type
      const where: any = { connectionId: connection.id };
      if (type === 'wix') {
        where.wixContactId = contactId;
      } else {
        where.hubSpotContactId = contactId;
      }

      const syncRecords = await prisma.contactSync.findMany({
        where,
        orderBy: { lastSyncedAt: 'desc' },
      });

      const syncLogs = await prisma.syncLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      res.json({
        success: true,
        data: {
          contactSyncs: syncRecords,
          recentSyncLogs: syncLogs,
        },
      });
    } catch (error) {
      console.error('Error fetching contact sync history:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch contact sync history' 
      });
    }
  };

  // ─────────────────────────────────────────────
  // MANUAL SYNC OPERATIONS
  // ─────────────────────────────────────────────

  /**
   * Manually sync a specific Wix contact to HubSpot
   * POST /api/sync/wix-to-hubspot/:instanceId
   */
  manualSyncWixToHubSpot = async (req: Request, res: Response) => {
    const correlationId = uuidv4();
    
    try {
      const { instanceId } = req.params;
      const { contactId, email } = req.body;

      if (!contactId && !email) {
        return res.status(400).json({ 
          success: false, 
          error: 'Either contactId or email is required' 
        });
      }

      // Find connection
      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active HubSpot connection found' 
        });
      }

      let wixContact;
      
      // Fetch Wix contact by ID or email
      if (contactId) {
        wixContact = await this.wixService.getContact(connection.id, contactId);
      } else if (email) {
        wixContact = await this.wixService.queryContactByEmail(connection.id, email);
      }

      if (!wixContact) {
        return res.status(404).json({ 
          success: false, 
          error: 'Wix contact not found' 
        });
      }

      // Perform sync
      await this.syncService.syncWixContactToHubSpot(
        connection.id,
        wixContact.id,
        wixContact,
        correlationId
      );

      res.json({
        success: true,
        message: 'Contact synced successfully',
        data: {
          wixContactId: wixContact.id,
          correlationId,
        },
      });
    } catch (error) {
      console.error('Manual sync failed:', error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Manual sync failed' 
      });
    }
  };

  /**
   * Manually sync a specific HubSpot contact to Wix
   * POST /api/sync/hubspot-to-wix/:instanceId
   */
  manualSyncHubSpotToWix = async (req: Request, res: Response) => {
    const correlationId = uuidv4();
    
    try {
      const { instanceId } = req.params;
      const { contactId, email } = req.body;

      if (!contactId && !email) {
        return res.status(400).json({ 
          success: false, 
          error: 'Either contactId or email is required' 
        });
      }

      // Find connection
      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active HubSpot connection found' 
        });
      }

      let hubSpotContact;
      
      // Fetch HubSpot contact by ID or email
      if (contactId) {
        hubSpotContact = await this.hubspotService.getContact(connection.id, contactId);
      } else if (email) {
        hubSpotContact = await this.hubspotService.searchContactByEmail(connection.id, email);
      }

      if (!hubSpotContact) {
        return res.status(404).json({ 
          success: false, 
          error: 'HubSpot contact not found' 
        });
      }

      // Perform sync
      await this.syncService.syncHubSpotContactToWix(
        connection.id,
        hubSpotContact.id,
        hubSpotContact,
        correlationId
      );

      res.json({
        success: true,
        message: 'Contact synced successfully',
        data: {
          hubSpotContactId: hubSpotContact.id,
          correlationId,
        },
      });
    } catch (error) {
      console.error('Manual sync failed:', error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Manual sync failed' 
      });
    }
  };

  /**
   * Bulk sync all contacts
   * POST /api/sync/bulk/:instanceId
   */
  bulkSync = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { direction = 'wix_to_hubspot', limit = 100 } = req.body;

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active HubSpot connection found' 
        });
      }

      // Start background job
      res.json({
        success: true,
        message: 'Bulk sync started',
        data: {
          direction,
          limit,
          status: 'processing',
        },
      });

      // Process in background
      this.processBulkSync(connection.id, direction, limit).catch(error => {
        console.error('Bulk sync failed:', error);
      });
    } catch (error) {
      console.error('Failed to start bulk sync:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to start bulk sync' 
      });
    }
  };

  private async processBulkSync(connectionId: string, direction: string, limit: number) {
    const correlationId = uuidv4();
    
    try {
      if (direction === 'wix_to_hubspot') {
        // Fetch Wix contacts (you'll need to implement pagination in WixService)
        // This is a placeholder - implement based on Wix API capabilities
        console.log(`Processing bulk sync Wix → HubSpot for connection ${connectionId}`);
      } else {
        // Fetch HubSpot contacts
        console.log(`Processing bulk sync HubSpot → Wix for connection ${connectionId}`);
      }
    } catch (error) {
      console.error('Bulk sync processing error:', error);
    }
  }

  // ─────────────────────────────────────────────
  // SYNC STATUS & STATISTICS
  // ─────────────────────────────────────────────

  /**
   * Get sync statistics and health status
   * GET /api/sync/status/:instanceId
   */
  getSyncStatus = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { hours = 24 } = req.query;

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active connection found' 
        });
      }

      const sinceDate = new Date();
      sinceDate.setHours(sinceDate.getHours() - Number(hours));

      // Get various statistics
      const [totalSyncs, failedSyncs, recentSyncs, contactStats] = await Promise.all([
        prisma.syncLog.count({
          where: { connectionId: connection.id },
        }),
        prisma.syncLog.count({
          where: { 
            connectionId: connection.id,
            status: 'failed',
          },
        }),
        prisma.syncLog.count({
          where: {
            connectionId: connection.id,
            createdAt: { gte: sinceDate },
          },
        }),
        prisma.contactSync.count({
          where: { connectionId: connection.id },
        }),
      ]);

      // Get last sync time
      const lastSync = await prisma.syncLog.findFirst({
        where: { connectionId: connection.id },
        orderBy: { createdAt: 'desc' },
      });

      // Check connection health
      const isHubSpotHealthy = await this.hubspotService.testConnection(connection.id);

      res.json({
        success: true,
        data: {
          totalSyncs,
          failedSyncs,
          successRate: totalSyncs > 0 ? ((totalSyncs - failedSyncs) / totalSyncs * 100).toFixed(2) : '100',
          recentSyncsLast24Hours: recentSyncs,
          totalSyncedContacts: contactStats,
          lastSyncAt: lastSync?.createdAt || null,
          lastSyncStatus: lastSync?.status || null,
          hubSpotConnectionHealthy: isHubSpotHealthy,
          connection: {
            id: connection.id,
            portalId: connection.hubSpotPortalId,
            connectedAt: connection.createdAt,
          },
        },
      });
    } catch (error) {
      console.error('Error fetching sync status:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch sync status' 
      });
    }
  };

  /**
   * Get failed syncs for retry
   * GET /api/sync/failed/:instanceId
   */
  getFailedSyncs = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { limit = 50 } = req.query;

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active connection found' 
        });
      }

      const failedSyncs = await prisma.syncLog.findMany({
        where: {
          connectionId: connection.id,
          status: 'failed',
        },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
      });

      res.json({
        success: true,
        data: {
          failedSyncs,
          count: failedSyncs.length,
        },
      });
    } catch (error) {
      console.error('Error fetching failed syncs:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch failed syncs' 
      });
    }
  };

  /**
   * Retry a failed sync
   * POST /api/sync/retry/:logId
   */
  retryFailedSync = async (req: Request, res: Response) => {
    try {
      const { logId } = req.params;

      const failedLog = await prisma.syncLog.findUnique({
        where: { id: logId },
      });

      if (!failedLog || failedLog.status !== 'failed') {
        return res.status(404).json({ 
          success: false, 
          error: 'Failed sync log not found or not in failed state' 
        });
      }

      const connection = await prisma.hubSpotConnection.findUnique({
        where: { id: failedLog.connectionId },
      });

      if (!connection || !connection.isConnected) {
        return res.status(404).json({ 
          success: false, 
          error: 'Connection not found or not active' 
        });
      }

      const newCorrelationId = uuidv4();

      // Retry based on direction
      if (failedLog.direction === 'wix_to_hubspot' && failedLog.wixContactId) {
        const wixContact = await this.wixService.getContact(
          connection.id,
          failedLog.wixContactId
        );
        
        await this.syncService.syncWixContactToHubSpot(
          connection.id,
          failedLog.wixContactId,
          wixContact,
          newCorrelationId
        );
      } else if (failedLog.direction === 'hubspot_to_wix' && failedLog.hubSpotContactId) {
        const hubSpotContact = await this.hubspotService.getContact(
          connection.id,
          failedLog.hubSpotContactId
        );
        
        await this.syncService.syncHubSpotContactToWix(
          connection.id,
          failedLog.hubSpotContactId,
          hubSpotContact,
          newCorrelationId
        );
      }

      res.json({
        success: true,
        message: 'Retry initiated successfully',
        data: { newCorrelationId },
      });
    } catch (error) {
      console.error('Error retrying failed sync:', error);
      res.status(500).json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to retry sync' 
      });
    }
  };

  /**
   * Clear old sync logs
   * DELETE /api/sync/logs/clear/:instanceId
   */
  clearOldSyncLogs = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { daysToKeep = 30 } = req.body;

      const connection = await prisma.hubSpotConnection.findFirst({
        where: { 
          wixInstanceId: instanceId,
          isConnected: true 
        }
      });

      if (!connection) {
        return res.status(404).json({ 
          success: false, 
          error: 'No active connection found' 
        });
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const deleted = await prisma.syncLog.deleteMany({
        where: {
          connectionId: connection.id,
          createdAt: { lt: cutoffDate },
          status: 'success',
        },
      });

      res.json({
        success: true,
        message: `Cleared ${deleted.count} old sync logs`,
        data: { deletedCount: deleted.count },
      });
    } catch (error) {
      console.error('Error clearing sync logs:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to clear sync logs' 
      });
    }
  };
}
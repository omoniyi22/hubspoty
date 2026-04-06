import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { MappingService } from '../services/mapping.service';

export class MappingController {
  private mappingService = MappingService.getInstance();

  getFieldMapping = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;

      const connection = await prisma.hubSpotConnection.findUnique({
        where: { wixInstanceId: instanceId, isConnected: true }
      });

      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const mapping = await this.mappingService.getFieldMapping(connection.id);
      
      const uiMappings = mapping.mappings.map(m => ({
        wixField: m.wixField,
        hubSpotProperty: m.hubSpotProperty,
        direction: m.direction,
        transform: m.transform || null,
        isEssential: m.isEssential,
        isActive: m.isActive,
        lastSeenAt: m.lastSeenAt,
      }));
      
      res.json({ mappings: uiMappings });
    } catch (error) {
      console.error('Error getting field mapping:', error);
      res.status(500).json({ error: 'Failed to get field mapping' });
    }
  };

  updateFieldMapping = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { updates } = req.body;
      console.log({updates, body: req.body})

      const connection = await prisma.hubSpotConnection.findUnique({
        where: { wixInstanceId: instanceId, isConnected: true }
      });

      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      if (!updates || !Array.isArray(updates)) {
        return res.status(400).json({ error: 'Invalid updates format' });
      }

      for (const update of updates) {
        if (!update.wixField) {
          return res.status(400).json({ error: 'Each update must have wixField' });
        }
        
        if (update.direction && !['wix_to_hubspot', 'hubspot_to_wix', 'bidirectional'].includes(update.direction)) {
          return res.status(400).json({ error: `Invalid direction for field ${update.wixField}` });
        }
        
        if (update.transform && !['trim', 'lowercase', 'uppercase', 'email', null].includes(update.transform)) {
          return res.status(400).json({ error: `Invalid transform for field ${update.wixField}` });
        }
        
        if (update.isActive !== undefined && typeof update.isActive !== 'boolean') {
          return res.status(400).json({ error: `isActive must be boolean for field ${update.wixField}` });
        }
      }

      await this.mappingService.updateMappingRules(connection.id, updates);
      
      res.json({ success: true, message: 'Mapping rules updated successfully' });
    } catch (error) {
      console.error('Error updating field mapping:', error);
      res.status(500).json({ error: 'Failed to update field mapping' });
    }
  };

  getAvailableFields = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      
      const connection = await prisma.hubSpotConnection.findUnique({
        where: { wixInstanceId: instanceId, isConnected: true }
      });

      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const mapping = await this.mappingService.getFieldMapping(connection.id);
      
      const wixFields = mapping.mappings.map(m => ({
        value: m.wixField,
        label: m.wixField.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()),
        isEssential: m.isEssential,
        isActive: m.isActive,
        direction: m.direction,
      }));
      
      const hubSpotProperties = mapping.mappings.map(m => ({
        value: m.hubSpotProperty,
        label: m.hubSpotProperty.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      }));
      
      res.json({ wixFields, hubSpotProperties });
    } catch (error) {
      console.error('Error getting available fields:', error);
      res.status(500).json({ error: 'Failed to get available fields' });
    }
  };
}
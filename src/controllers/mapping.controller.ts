// src/controllers/mapping.controller.ts
import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { SyncService } from '../services/sync.service';
import { FieldMappingConfig } from '../types';

export class MappingController {
  private syncService = SyncService.getInstance();

  getFieldMapping = async (req: Request, res: Response) => {
    const { instanceId } = req.params;

    const connection = await prisma.hubSpotConnection.findUnique({
      where: { wixInstanceId: instanceId, isConnected: true }
    });

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    const mapping = await this.syncService.getFieldMapping(connection.id);
    res.json(mapping);
  };

  updateFieldMapping = async (req: Request, res: Response) => {
    const { instanceId } = req.params;
    const mappings: FieldMappingConfig = req.body;

    const connection = await prisma.hubSpotConnection.findUnique({
      where: { wixInstanceId: instanceId, isConnected: true }
    });

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Validate mappings
    if (!mappings.mappings || !Array.isArray(mappings.mappings)) {
      return res.status(400).json({ error: 'Invalid mapping format' });
    }

    // Check for duplicate HubSpot properties
    const hubSpotProperties = mappings.mappings.map(m => m.hubSpotProperty);
    if (new Set(hubSpotProperties).size !== hubSpotProperties.length) {
      return res.status(400).json({ error: 'Duplicate HubSpot properties found' });
    }

    await this.syncService.updateFieldMapping(connection.id, mappings);
    res.json({ success: true, mappings });
  };

  getAvailableFields = async (req: Request, res: Response) => {
    // Return available Wix fields and HubSpot properties
    const wixFields = [
      { value: 'email', label: 'Email' },
      { value: 'firstName', label: 'First Name' },
      { value: 'lastName', label: 'Last Name' },
      { value: 'phone', label: 'Phone' },
      { value: 'address', label: 'Address' },
      { value: 'city', label: 'City' },
      { value: 'country', label: 'Country' },
      { value: 'birthdate', label: 'Birthdate' },
      { value: 'company', label: 'Company' },
      { value: 'position', label: 'Position' }
    ];

    const hubSpotProperties = [
      { value: 'email', label: 'Email' },
      { value: 'firstname', label: 'First Name' },
      { value: 'lastname', label: 'Last Name' },
      { value: 'phone', label: 'Phone' },
      { value: 'address', label: 'Address' },
      { value: 'city', label: 'City' },
      { value: 'country', label: 'Country' },
      { value: 'birthdate', label: 'Birthdate' },
      { value: 'company', label: 'Company Name' },
      { value: 'jobtitle', label: 'Job Title' },
      { value: 'website', label: 'Website' },
      { value: 'linkedin', label: 'LinkedIn' },
      { value: 'twitter', label: 'Twitter' }
    ];

    res.json({ wixFields, hubSpotProperties });
  };
}
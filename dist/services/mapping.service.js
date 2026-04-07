"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MappingService = void 0;
const database_1 = require("../config/database");
class MappingService {
    constructor() {
        // Essential fields that MUST exist for every connection
        this.ESSENTIAL_MAPPINGS = [
            { wixField: 'email', hubSpotProperty: 'email', direction: 'bidirectional', transform: 'email' },
            { wixField: 'firstName', hubSpotProperty: 'firstname', direction: 'bidirectional', transform: 'trim' },
            { wixField: 'lastName', hubSpotProperty: 'lastname', direction: 'bidirectional', transform: 'trim' },
            { wixField: 'phone', hubSpotProperty: 'phone', direction: 'bidirectional', transform: 'trim' },
        ];
    }
    static getInstance() {
        if (!MappingService.instance) {
            MappingService.instance = new MappingService();
        }
        return MappingService.instance;
    }
    async initializeDefaultMappings(connectionId) {
        console.log(`[MappingService] Initializing default mappings for connection: ${connectionId}`);
        const defaultMappings = this.ESSENTIAL_MAPPINGS.map(mapping => ({
            ...mapping,
            isEssential: true,
            isActive: true,
            discoveredAt: new Date(),
            lastSeenAt: new Date(),
        }));
        await database_1.prisma.fieldMapping.upsert({
            where: { connectionId },
            update: { mappings: defaultMappings },
            create: { connectionId, mappings: defaultMappings },
        });
        console.log(`[MappingService] Created ${defaultMappings.length} essential mappings`);
    }
    async getFieldMapping(connectionId) {
        const mapping = await database_1.prisma.fieldMapping.findUnique({
            where: { connectionId }
        });
        if (!mapping) {
            await this.initializeDefaultMappings(connectionId);
            return this.getFieldMapping(connectionId);
        }
        return { mappings: mapping.mappings };
    }
    async updateMappingRules(connectionId, updates) {
        const current = await this.getFieldMapping(connectionId);
        const mappingMap = new Map();
        current.mappings.forEach(m => mappingMap.set(m.wixField, m));
        for (const update of updates) {
            const existing = mappingMap.get(update.wixField);
            if (existing) {
                if (update.direction !== undefined) {
                    existing.direction = update.direction;
                }
                if (update.transform !== undefined) {
                    existing.transform = update.transform || undefined;
                }
                if (update.isActive !== undefined) {
                    existing.isActive = update.isActive;
                }
                existing.lastSeenAt = new Date();
                mappingMap.set(update.wixField, existing);
            }
        }
        await database_1.prisma.fieldMapping.update({
            where: { connectionId },
            data: { mappings: Array.from(mappingMap.values()) }
        });
        console.log(`[MappingService] Updated ${updates.length} mapping rules`);
    }
    async discoverAndAddFields(connectionId, wixContact) {
        const current = await this.getFieldMapping(connectionId);
        const existingFields = new Set(current.mappings.map(m => m.wixField));
        const newMappings = [];
        // Fields to ALWAYS include (the essential ones are already there)
        // Only discover new fields that are simple string/number values
        const wixFields = Object.keys(wixContact).filter(key => {
            const value = wixContact[key];
            // Skip metadata and internal fields
            const excludedFields = ['id', 'version', 'customFields', 'createdDate', 'updatedDate', 'revision'];
            if (excludedFields.includes(key))
                return false;
            // Only include primitive values that are useful for sync
            const isValidType = typeof value === 'string' || typeof value === 'number';
            // Exclude null/undefined
            const hasValue = value !== null && value !== undefined && value !== '';
            // Exclude objects and arrays
            const isNotObject = typeof value !== 'object';
            return isValidType && hasValue && isNotObject && !excludedFields.includes(key);
        });
        for (const field of wixFields) {
            if (!existingFields.has(field)) {
                // Map common Wix field names to HubSpot property names
                let hubSpotProperty = field;
                // Common field mappings
                const fieldMappings = {
                    'firstName': 'firstname',
                    'lastName': 'lastname',
                    'jobTitle': 'jobtitle',
                    'birthdate': 'birthdate',
                    'company': 'company',
                    'address': 'address',
                    'city': 'city',
                    'state': 'state',
                    'zip': 'zip',
                    'zipCode': 'zip',
                    'country': 'country',
                    'website': 'website',
                    'phone': 'phone',
                    'email': 'email',
                };
                if (fieldMappings[field]) {
                    hubSpotProperty = fieldMappings[field];
                }
                else {
                    // Convert camelCase to snake_case for HubSpot
                    hubSpotProperty = field.replace(/([A-Z])/g, '_$1').toLowerCase();
                }
                // Validate HubSpot property name
                const isValidPropertyName = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(hubSpotProperty);
                if (!isValidPropertyName) {
                    console.log(`[MappingService] Skipping field ${field} - invalid HubSpot property name: ${hubSpotProperty}`);
                    continue;
                }
                const newMapping = {
                    wixField: field,
                    hubSpotProperty,
                    direction: 'bidirectional', // Default to bidirectional for discovered fields
                    transform: typeof wixContact[field] === 'string' ? 'trim' : undefined,
                    isEssential: false,
                    isActive: true,
                    discoveredAt: new Date(),
                    lastSeenAt: new Date(),
                };
                newMappings.push(newMapping);
                existingFields.add(field);
            }
            else {
                // Update lastSeenAt for existing field
                const existingMapping = current.mappings.find(m => m.wixField === field);
                if (existingMapping) {
                    existingMapping.lastSeenAt = new Date();
                }
            }
        }
        if (newMappings.length > 0) {
            const updatedMappings = [...current.mappings, ...newMappings];
            await database_1.prisma.fieldMapping.update({
                where: { connectionId },
                data: { mappings: updatedMappings }
            });
            console.log(`[MappingService] Discovered and added ${newMappings.length} new fields:`, newMappings.map(m => `${m.wixField} → ${m.hubSpotProperty}`));
        }
        // Update lastSeenAt for all fields that were seen
        let needsUpdate = false;
        const updatedMappings = current.mappings.map(mapping => {
            if (wixContact[mapping.wixField] !== undefined) {
                mapping.lastSeenAt = new Date();
                needsUpdate = true;
            }
            return mapping;
        });
        if (needsUpdate && newMappings.length === 0) {
            await database_1.prisma.fieldMapping.update({
                where: { connectionId },
                data: { mappings: updatedMappings }
            });
        }
        return newMappings;
    }
    async transformWixToHubSpot(connectionId, wixContact) {
        // Discover new fields
        await this.discoverAndAddFields(connectionId, wixContact);
        const { mappings } = await this.getFieldMapping(connectionId);
        const hubSpotData = {};
        console.log(`[MappingService] Transforming Wix → HubSpot for contact ${wixContact.id}`);
        for (const mapping of mappings) {
            // Skip inactive mappings
            if (!mapping.isActive) {
                console.log(`[MappingService] Skipping inactive field: ${mapping.wixField}`);
                continue;
            }
            // Skip if direction doesn't include Wix → HubSpot
            if (mapping.direction !== 'wix_to_hubspot' && mapping.direction !== 'bidirectional') {
                console.log(`[MappingService] Skipping field ${mapping.wixField} - direction is ${mapping.direction}`);
                continue;
            }
            // Get value from Wix contact
            let value = wixContact[mapping.wixField];
            if (value === null || value === undefined) {
                console.log(`[MappingService] Skipping field ${mapping.wixField} - no value`);
                continue;
            }
            // Skip objects
            if (typeof value === 'object') {
                console.log(`[MappingService] Skipping field ${mapping.wixField} - value is object`);
                continue;
            }
            // Convert to string if needed
            if (typeof value !== 'string') {
                value = String(value);
            }
            // Apply transform
            if (mapping.transform && typeof value === 'string') {
                switch (mapping.transform) {
                    case 'trim':
                        value = value.trim();
                        break;
                    case 'lowercase':
                        value = value.toLowerCase();
                        break;
                    case 'uppercase':
                        value = value.toUpperCase();
                        break;
                    case 'email':
                        value = value.toLowerCase().trim();
                        break;
                }
            }
            // Only add non-empty values
            if (value && value.length > 0) {
                hubSpotData[mapping.hubSpotProperty] = value;
                console.log(`[MappingService] Mapped ${mapping.wixField} → ${mapping.hubSpotProperty}: "${value}"`);
            }
        }
        console.log(`[MappingService] Final HubSpot data:`, hubSpotData);
        return hubSpotData;
    }
    async transformHubSpotToWix(connectionId, hubSpotContact) {
        const { mappings } = await this.getFieldMapping(connectionId);
        const wixData = {};
        console.log(`[MappingService] Transforming HubSpot → Wix`);
        for (const mapping of mappings) {
            // Skip inactive mappings
            if (!mapping.isActive) {
                console.log(`[MappingService] Skipping inactive field: ${mapping.hubSpotProperty}`);
                continue;
            }
            // Skip if direction doesn't include HubSpot → Wix
            if (mapping.direction !== 'hubspot_to_wix' && mapping.direction !== 'bidirectional') {
                console.log(`[MappingService] Skipping field ${mapping.hubSpotProperty} - direction is ${mapping.direction}`);
                continue;
            }
            // Get value from HubSpot contact
            let value = hubSpotContact[mapping.hubSpotProperty];
            if (value === null || value === undefined) {
                continue;
            }
            // Apply transform
            if (mapping.transform && typeof value === 'string') {
                switch (mapping.transform) {
                    case 'trim':
                        value = value.trim();
                        break;
                    case 'lowercase':
                        value = value.toLowerCase();
                        break;
                    case 'uppercase':
                        value = value.toUpperCase();
                        break;
                }
            }
            if (value && (typeof value === 'string' ? value.length > 0 : true)) {
                wixData[mapping.wixField] = value;
                console.log(`[MappingService] Mapped ${mapping.hubSpotProperty} → ${mapping.wixField}: "${value}"`);
            }
        }
        return wixData;
    }
}
exports.MappingService = MappingService;
//# sourceMappingURL=mapping.service.js.map
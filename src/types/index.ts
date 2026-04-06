export interface FieldMappingRule {
  wixField: string;
  hubSpotProperty: string;
  direction: 'wix_to_hubspot' | 'hubspot_to_wix' | 'bidirectional';
  transform?: 'trim' | 'lowercase' | 'uppercase' | 'email';
  isEssential: boolean;
  isActive: boolean;
  discoveredAt?: Date;
  lastSeenAt?: Date;
}

export interface FieldMappingConfig {
  mappings: FieldMappingRule[];
}

export interface HubSpotTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  hub_domain: string;
  hub_id: number;
  user_id: number;
}

// src/types/index.ts - Update WixContact interface

export interface WixContact {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  birthdate?: string;
  website?: string;
  customFields?: Record<string, any>;
  version?: number;
  [key: string]: any; // Keep for dynamic fields but will be filtered
}


export interface HubSpotContact {
  id: string;
  properties: {
    email?: string;
    firstname?: string;
    lastname?: string;
    phone?: string;
    [key: string]: any;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface UTMParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  page_url?: string;
  referrer?: string;
  timestamp?: string;
}
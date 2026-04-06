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

export interface WixContact {
  id: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
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
  [key: string]: any;
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

// NEW: Form submission type with attribution fields
export interface FormSubmissionRecord {
  id: string;
  connectionId: string;
  wixFormId: string;
  wixFormName?: string;
  hubSpotContactId: string;
  formData: any;
  utmParams: any;
  submittedAt: Date;
  syncedToHubSpot: boolean;
  hubSpotSubmissionId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  pageUrl?: string;
  referrer?: string;
  leadStatus?: string;
  leadScore?: number;
}
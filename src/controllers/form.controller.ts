import { Request, Response } from 'express';
import { prisma } from '../config/database';

export class FormController {
  /**
   * Get form submissions with pagination and filters
   * GET /api/forms/submissions/:instanceId
   */
  getFormSubmissions = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { 
        page = 1, 
        limit = 50,
        utmSource,
        utmCampaign,
        leadStatus,
        startDate,
        endDate,
        formName
      } = req.query;

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
          error: 'No active connection found' 
        });
      }

      // Build filter conditions
      const where: any = { connectionId: connection.id };
      
      if (utmSource) where.utmSource = utmSource;
      if (utmCampaign) where.utmCampaign = utmCampaign;
      if (leadStatus) where.leadStatus = leadStatus;
      if (formName) where.wixFormName = { contains: formName, mode: 'insensitive' };
      
      if (startDate || endDate) {
        where.submittedAt = {};
        if (startDate) where.submittedAt.gte = new Date(startDate as string);
        if (endDate) where.submittedAt.lte = new Date(endDate as string);
      }

      // Get total count
      const total = await prisma.formSubmission.count({ where });

      // Get paginated submissions
      const submissions = await prisma.formSubmission.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      });

      // Get summary statistics
      const stats = await prisma.formSubmission.groupBy({
        by: ['leadStatus'],
        where: { connectionId: connection.id },
        _count: true,
      });

      const utmStats = await prisma.formSubmission.groupBy({
        by: ['utmSource', 'utmCampaign'],
        where: { connectionId: connection.id },
        _count: true,
        _sum: { leadScore: true },
      });

      res.json({
        success: true,
        data: {
          submissions,
          pagination: {
            page: Number(page),
            limit: Number(limit),
            total,
            totalPages: Math.ceil(total / Number(limit)),
          },
          stats: {
            total,
            byStatus: stats.reduce((acc, curr) => {
              acc[curr.leadStatus || 'unknown'] = curr._count;
              return acc;
            }, {} as Record<string, number>),
            utmBreakdown: utmStats.filter(s => s.utmSource).map(s => ({
              source: s.utmSource,
              campaign: s.utmCampaign,
              count: s._count,
              totalScore: s._sum.leadScore || 0,
            })),
          },
        },
      });
    } catch (error) {
      console.error('Error fetching form submissions:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch form submissions' 
      });
    }
  };

  /**
   * Get a single form submission by ID
   * GET /api/forms/submissions/detail/:submissionId
   */
  getFormSubmissionById = async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params;

      const submission = await prisma.formSubmission.findUnique({
        where: { id: submissionId },
        include: {
          connection: {
            select: {
              wixInstanceId: true,
              hubSpotPortalId: true,
            },
          },
        },
      });

      if (!submission) {
        return res.status(404).json({ 
          success: false, 
          error: 'Form submission not found' 
        });
      }

      res.json({ success: true, data: submission });
    } catch (error) {
      console.error('Error fetching form submission:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch form submission' 
      });
    }
  };

  /**
   * Get form submission statistics
   * GET /api/forms/stats/:instanceId
   */
  getFormStats = async (req: Request, res: Response) => {
    try {
      const { instanceId } = req.params;
      const { days = 30 } = req.query;

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
      sinceDate.setDate(sinceDate.getDate() - Number(days));

      // Get submissions by day
      const submissionsByDay = await prisma.$queryRaw`
        SELECT 
          DATE("submittedAt") as date,
          COUNT(*) as count,
          COUNT(CASE WHEN "leadStatus" = 'new' THEN 1 END) as new_leads,
          COUNT(CASE WHEN "leadStatus" = 'contacted' THEN 1 END) as contacted,
          COUNT(CASE WHEN "leadStatus" = 'qualified' THEN 1 END) as qualified
        FROM "FormSubmission"
        WHERE "connectionId" = ${connection.id}
          AND "submittedAt" >= ${sinceDate}
        GROUP BY DATE("submittedAt")
        ORDER BY date DESC
        LIMIT 30
      `;

      // Get top sources
      const topSources = await prisma.formSubmission.groupBy({
        by: ['utmSource'],
        where: { 
          connectionId: connection.id,
          utmSource: { not: null }
        },
        _count: true,
        orderBy: { _count: { utmSource: 'desc' } },
        take: 10,
      });

      // Get top campaigns
      const topCampaigns = await prisma.formSubmission.groupBy({
        by: ['utmCampaign'],
        where: { 
          connectionId: connection.id,
          utmCampaign: { not: null }
        },
        _count: true,
        orderBy: { _count: { utmCampaign: 'desc' } },
        take: 10,
      });

      res.json({
        success: true,
        data: {
          submissionsByDay,
          topSources: topSources.map(s => ({ source: s.utmSource, count: s._count })),
          topCampaigns: topCampaigns.map(s => ({ campaign: s.utmCampaign, count: s._count })),
          totalSubmissions: await prisma.formSubmission.count({ 
            where: { connectionId: connection.id } 
          }),
          last7Days: await prisma.formSubmission.count({
            where: {
              connectionId: connection.id,
              submittedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
            }
          }),
        },
      });
    } catch (error) {
      console.error('Error fetching form stats:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch form statistics' 
      });
    }
  };

  /**
   * Update lead status
   * PUT /api/forms/submissions/:submissionId/status
   */
  updateLeadStatus = async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params;
      const { leadStatus, leadScore } = req.body;

      const validStatuses = ['new', 'contacted', 'qualified', 'lost', 'pending'];
      if (leadStatus && !validStatuses.includes(leadStatus)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid lead status' 
        });
      }

      const updateData: any = {};
      if (leadStatus) updateData.leadStatus = leadStatus;
      if (leadScore !== undefined) updateData.leadScore = leadScore;

      const submission = await prisma.formSubmission.update({
        where: { id: submissionId },
        data: updateData,
      });

      res.json({ 
        success: true, 
        data: submission,
        message: 'Lead status updated successfully'
      });
    } catch (error) {
      console.error('Error updating lead status:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to update lead status' 
      });
    }
  };
}
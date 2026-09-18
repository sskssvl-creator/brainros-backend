import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { ContactFormDto } from '../dto/contact.dto';
import { ResendEmailService } from '../../admin/services/resend-email.service';

@Controller('public/contact')
export class PublicContactController {
  private readonly logger = new Logger(PublicContactController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly resendEmailService: ResendEmailService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async submitContactForm(@Body() dto: ContactFormDto) {
    // 1. Honeypot check: reject bots that fill hidden fields
    if (dto.honeypot && dto.honeypot.trim().length > 0) {
      this.logger.warn(`[PublicContact] Bot submission detected via honeypot from ${dto.email}`);
      // Return a simulated success to prevent bot adaptation
      return {
        success: true,
        message: 'Thank you. Your message has been received.',
      };
    }

    // 2. Resolve destination email for backend forwarding
    const recipientEmail =
      this.configService.get<string>('CONTACT_EMAIL') ||
      process.env.CONTACT_EMAIL ||
      'sskssvl@gmail.com';

    const cleanRecipient = recipientEmail.includes('<')
      ? recipientEmail.replace(/.*<([^>]+)>.*/, '$1').trim()
      : recipientEmail.trim();

    // 3. Format message contents securely
    const sanitizedSubject = dto.subject
      ? `[Brainros Contact] ${dto.subject.replace(/[\r\n]+/g, ' ').slice(0, 100)}`
      : `[Brainros Contact] New Inquiry from ${dto.name}`;

    const htmlBody = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <div style="margin-bottom: 20px; border-bottom: 2px solid #4f46e5; padding-bottom: 12px;">
          <h2 style="color: #1e1b4b; margin: 0; font-size: 20px;">New Public Contact Inquiry</h2>
          <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px;">Received via Brainros Public Website</p>
        </div>
        
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
          <tr>
            <td style="padding: 8px 0; color: #64748b; width: 140px; font-weight: 600;">Sender Name:</td>
            <td style="padding: 8px 0; color: #0f172a; font-weight: 500;">${escapeHtml(dto.name)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Email Address:</td>
            <td style="padding: 8px 0; color: #0f172a;"><a href="mailto:${escapeHtml(dto.email)}" style="color: #4f46e5;">${escapeHtml(dto.email)}</a></td>
          </tr>
          ${
            dto.phone
              ? `<tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">Phone Number:</td><td style="padding: 8px 0; color: #0f172a;">${escapeHtml(dto.phone)}</td></tr>`
              : ''
          }
          ${
            dto.institution
              ? `<tr><td style="padding: 8px 0; color: #64748b; font-weight: 600;">Institution / Org:</td><td style="padding: 8px 0; color: #0f172a;">${escapeHtml(dto.institution)}</td></tr>`
              : ''
          }
        </table>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-top: 12px;">
          <h4 style="margin: 0 0 8px 0; color: #334155; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Message Details:</h4>
          <p style="margin: 0; color: #1e293b; line-height: 1.6; white-space: pre-wrap; font-size: 14px;">${escapeHtml(dto.message)}</p>
        </div>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
          Sent securely via Brainros Exam Platform &bull; ${new Date().toUTCString()}
        </div>
      </div>
    `;

    // 4. Dispatch email via Resend
    try {
      const sendResult = await this.resendEmailService.sendEmail({
        from: 'onboarding@resend.dev',
        to: cleanRecipient || 'sskssvl@gmail.com',
        subject: sanitizedSubject,
        html: htmlBody,
      });

      if (!sendResult.success) {
        this.logger.error(`[PublicContact] Dispatch failed: ${sendResult.error}`);
        
        // If Resend rejected due to testing domain limitation, provide clear message
        if (sendResult.error?.includes('You can only send testing emails') || sendResult.error?.includes('verify a domain')) {
          throw new BadRequestException(
            'Resend Sandbox Restriction: Testing emails can only be delivered to the registered Resend account email (sskssvl@gmail.com). To send to a custom domain, please verify a custom domain on resend.com or use a verified sender.'
          );
        }

        throw new BadRequestException(sendResult.error || 'Failed to dispatch email.');
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(`[PublicContact] Failed to dispatch contact email: ${err.message}`);
      throw new BadRequestException(err.message || 'Failed to dispatch email.');
    }

    return {
      success: true,
      message: 'Thank you. Your message has been received.',
    };
  }
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

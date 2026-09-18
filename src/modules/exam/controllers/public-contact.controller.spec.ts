import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PublicContactController } from './public-contact.controller';
import { ResendEmailService } from '../../admin/services/resend-email.service';

describe('PublicContactController', () => {
  let controller: PublicContactController;
  let resendEmailService: Partial<ResendEmailService>;
  let configService: Partial<ConfigService>;

  beforeEach(async () => {
    resendEmailService = {
      sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'msg_123' }),
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'CONTACT_EMAIL') return 'support@brainros.com';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicContactController],
      providers: [
        { provide: ConfigService, useValue: configService },
        { provide: ResendEmailService, useValue: resendEmailService },
      ],
    }).compile();

    controller = module.get<PublicContactController>(PublicContactController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should process genuine contact form submission and dispatch email', async () => {
    const result = await controller.submitContactForm({
      name: 'Aditi Sharma',
      email: 'aditi@example.com',
      phone: '+91 9876543210',
      institution: 'Delhi Public School',
      subject: 'Institutional Mock Testing Inquiries',
      message: 'We want to evaluate Brainros for 500 NEET aspirants in our school.',
    });

    expect(result).toEqual({
      success: true,
      message: 'Thank you. Your message has been received.',
    });
    expect(resendEmailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(resendEmailService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support@brainros.com',
        subject: expect.stringContaining('Institutional Mock Testing Inquiries'),
        html: expect.stringContaining('Aditi Sharma'),
      }),
    );
  });

  it('should drop bot submission silently when honeypot is filled', async () => {
    const result = await controller.submitContactForm({
      name: 'Spam Bot',
      email: 'spambot@spam.com',
      message: 'Buy cheap watches now!',
      honeypot: 'http://spamlink.com',
    });

    expect(result).toEqual({
      success: true,
      message: 'Thank you. Your message has been received.',
    });
    // Email should NOT be sent for honeypot bot submissions
    expect(resendEmailService.sendEmail).not.toHaveBeenCalled();
  });

  it('should return graceful success response even if Resend service fails', async () => {
    (resendEmailService.sendEmail as jest.Mock).mockRejectedValueOnce(
      new Error('Resend network timeout'),
    );

    const result = await controller.submitContactForm({
      name: 'Rohan Verma',
      email: 'rohan@example.com',
      message: 'Can I get information on JEE mock packages?',
    });

    expect(result).toEqual({
      success: true,
      message: 'Thank you. Your message has been received.',
    });
  });
});

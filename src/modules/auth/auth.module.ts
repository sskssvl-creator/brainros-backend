import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { OtpController } from './otp.controller';
import { OtpService } from './services/otp.service';
import { TokenService } from './services/token.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { OAuthService } from './services/oauth.service';
import { SecurityEventService } from './services/security-event.service';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';

import { DevelopmentOtpProvider } from './two-factor/development-otp.provider';
import { TwilioOtpService } from './two-factor/twilio-otp.service';
import { TwilioVerifyProvider } from './two-factor/twilio-verify.provider';
import { TwoFactorService } from './two-factor/two-factor.service';
import { TwoFactorConfig } from './config/two-factor.config';
import { RedisModule } from '../redis/redis.module';

import { PaymentWebhookController } from './controllers/payment-webhook.controller';

@Module({
  imports: [
    HttpModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret:
        process.env.JWT_SECRET || 'super-secret-jwt-key-replace-in-production',
      signOptions: { expiresIn: '15m' },
    }),
    RedisModule,
  ],
  controllers: [AuthController, OtpController, PaymentWebhookController],

  providers: [
    TwoFactorConfig,
    TwilioOtpService,
    TwilioVerifyProvider,
    DevelopmentOtpProvider,
    TwoFactorService,
    OtpService,
    AuthService,
    TokenService,
    PasswordService,
    SessionService,
    OAuthService,
    SecurityEventService,
    JwtStrategy,
  ],
  exports: [
    AuthService,
    PassportModule,
    JwtModule,
    SecurityEventService,
    SessionService,
    TokenService,
    TwoFactorConfig,
    TwilioOtpService,
    TwilioVerifyProvider,
    TwoFactorService,
    OtpService,
  ],
})
export class AuthModule {}

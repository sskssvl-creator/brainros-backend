import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';
import { NotificationModule } from '../notification/notification.module';
import { StorageService } from '../../common/services/storage.service';

// Controllers
import { SalesAgentController } from './controllers/sales-agent.controller';
import { SalesVisitController } from './controllers/sales-visit.controller';
import { SalesTargetController } from './controllers/sales-target.controller';
import { AdminSalesController } from './controllers/admin-sales.controller';

// Services
import { SalesAgentService } from './services/sales-agent.service';
import { SalesVisitService } from './services/sales-visit.service';
import { SalesTargetService } from './services/sales-target.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AdminModule,
    NotificationModule,
  ],
  controllers: [
    SalesAgentController,
    SalesVisitController,
    SalesTargetController,
    AdminSalesController,
  ],
  providers: [
    StorageService,
    SalesAgentService,
    SalesVisitService,
    SalesTargetService,
  ],
  exports: [
    SalesAgentService,
    SalesVisitService,
    SalesTargetService,
  ],
})
export class SalesAgentModule {}

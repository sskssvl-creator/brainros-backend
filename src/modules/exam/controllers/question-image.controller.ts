import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { StorageService } from '../../../common/services/storage.service';
import { v4 as uuidv4 } from 'uuid';

@Controller('admin/exam-manager')
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuestionImageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload-question-image')
  @Roles('SUPER_ADMIN', 'ADMIN', 'GENERAL_MANAGER', 'MANAGER', 'OPERATOR')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
      fileFilter: (_req, file, cb) => {
        const allowed = [
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/svg+xml',
          'image/gif',
        ];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Unsupported file type. Please upload JPEG, PNG, WebP, or SVG.',
            ),
            false,
          );
        }
      },
    }),
  )
  async uploadQuestionImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Image file is required');
    }

    const uploadResult = await this.storageService.uploadImage(
      file.buffer,
      file.originalname || 'image.png',
      file.mimetype,
      'brainros/question-images',
    );

    return {
      statusCode: 200,
      message: 'Question image uploaded successfully',
      data: {
        url: uploadResult.url,
        key: uploadResult.key,
        provider: uploadResult.provider,
        originalName: file.originalname,
        size: file.size,
      },
    };
  }
}

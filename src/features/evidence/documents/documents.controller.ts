import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
  Version,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { documentsApiExamples } from './api-examples/documents.api-examples';
import { MAX_FILE_SIZE_BYTES } from './documents.constant';
import { DocumentsService } from './documents.service';
import { UploadDocumentRequestDto } from './dtos/request/upload-document.request.dto';
import { DocumentResponseDto } from './dtos/response/document.response.dto';
import { DocumentWithVersionsResponseDto } from './dtos/response/document-with-versions.response.dto';
import { EvidenceChunkResponseDto } from './dtos/response/evidence-chunk.response.dto';
import type { UploadedFileLike } from './types/uploaded-file.type';

@Controller('documents')
@ApiTags('documents')
@ApiBearerAuth()
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  // Content addressing: `documentId` in the body is how a caller says "this is a new version
  // of an existing document" rather than "this is a new document" — the task's endpoint list
  // has exactly one upload route, so a route-parameter variant (`/documents/:id/versions`)
  // would add a second endpoint outside that contract. Omitting `documentId` creates a new
  // document from this upload; supplying it targets that document's version chain.
  @Post()
  @Version('1')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        documentId: { type: 'string' },
        title: { type: 'string' },
        requireApproval: { type: 'boolean' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 } }))
  @ApiResponse(documentsApiExamples.uploaded)
  @ApiResponse(documentsApiExamples.unsupportedType)
  @ApiResponse(documentsApiExamples.notFound)
  async upload(
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: UploadDocumentRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<DocumentResponseDto> {
    // JwtAuthGuard always sets request.user before a non-public handler runs; this guards
    // the type only (request.user is optional because the same type covers public routes).
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      DocumentResponseDto,
      await this.documentsService.upload(file, dto, user.tenantId),
    );
  }

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(documentsApiExamples.list)
  async list(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<DocumentResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.documentsService.list(pagination, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(DocumentResponseDto, doc)), count };
  }

  @Get(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(documentsApiExamples.detail)
  @ApiResponse(documentsApiExamples.notFound)
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<DocumentWithVersionsResponseDto> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    return toResponseDto(
      DocumentWithVersionsResponseDto,
      await this.documentsService.getById(id, user.tenantId),
    );
  }

  // Buffered, not streamed: uploads already buffer under `MAX_FILE_SIZE_BYTES`, so returning a
  // buffered `StreamableFile` here is consistent with that cap rather than a new streaming path.
  @Get('versions/:versionId/content')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(documentsApiExamples.versionContent)
  @ApiResponse(documentsApiExamples.versionContentNotFound)
  async getVersionContent(
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<StreamableFile> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { content, contentType, filename } = await this.documentsService.getVersionContent(
      versionId,
      user.userId,
      user.tenantId,
    );

    return new StreamableFile(content, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('versions/:versionId/chunks')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(documentsApiExamples.versionChunks)
  @ApiResponse(documentsApiExamples.versionChunksNotFound)
  async listVersionChunks(
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<EvidenceChunkResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.documentsService.listVersionChunks(
      versionId,
      user.userId,
      user.tenantId,
    );

    return { docs: docs.map((doc) => toResponseDto(EvidenceChunkResponseDto, doc)), count };
  }
}

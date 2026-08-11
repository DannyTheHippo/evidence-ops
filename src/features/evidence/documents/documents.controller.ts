import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  Version,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { documentsApiExamples } from './api-examples/documents.api-examples';
import { MAX_FILE_SIZE_BYTES } from './documents.constant';
import { DocumentsService } from './documents.service';
import { UploadDocumentRequestDto } from './dtos/request/upload-document.request.dto';
import { DocumentResponseDto } from './dtos/response/document.response.dto';
import { DocumentWithVersionsResponseDto } from './dtos/response/document-with-versions.response.dto';
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
  ): Promise<DocumentResponseDto> {
    return toResponseDto(DocumentResponseDto, await this.documentsService.upload(file, dto));
  }

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(documentsApiExamples.list)
  async list(
    @Query() pagination: PaginationRequestDto,
  ): Promise<WithCountResponseDto<DocumentResponseDto>> {
    const { docs, count } = await this.documentsService.list(pagination);

    return { docs: docs.map((doc) => toResponseDto(DocumentResponseDto, doc)), count };
  }

  @Get(':id')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(documentsApiExamples.detail)
  @ApiResponse(documentsApiExamples.notFound)
  async getById(@Param('id') id: string): Promise<DocumentWithVersionsResponseDto> {
    return toResponseDto(DocumentWithVersionsResponseDto, await this.documentsService.getById(id));
  }
}

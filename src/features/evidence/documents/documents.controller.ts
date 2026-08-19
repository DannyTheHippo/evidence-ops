import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Sse,
  StreamableFile,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Version,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { finalize } from 'rxjs';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { RequireRole } from '../../../shared/decorators/require-role.decorator';
import { PaginationRequestDto } from '../../../shared/dtos/request/pagination.request.dto';
import type { WithCountResponseDto } from '../../../shared/dtos/response/with-count.response.dto';
import { UserRole } from '../../../shared/enums/user-role.enum';
import { AuthenticatedRequest } from '../../../shared/types/authenticated-request.type';
import { acquireStreamSlot } from '../../../shared/utils/stream-session.util';
import { toResponseDto } from '../../../shared/utils/to-response-dto.util';
import { documentsApiExamples } from './api-examples/documents.api-examples';
import { MAX_FILE_SIZE_BYTES } from './documents.constant';
import { DocumentsService } from './documents.service';
import { ListDocumentsRequestDto } from './dtos/request/list-documents.request.dto';
import { UploadDocumentRequestDto } from './dtos/request/upload-document.request.dto';
import { DocumentResponseDto } from './dtos/response/document.response.dto';
import { DocumentWithVersionsResponseDto } from './dtos/response/document-with-versions.response.dto';
import { EvidenceChunkResponseDto } from './dtos/response/evidence-chunk.response.dto';
import type { UploadedFileLike } from './types/uploaded-file.type';

@Controller('documents')
@ApiTags('documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly config: TypedConfigService,
  ) {}

  // Content addressing: `documentId` in the body is how a caller says "this is a new version
  // of an existing document" rather than "this is a new document" — the task's endpoint list
  // has exactly one upload route, so a route-parameter variant (`/documents/:id/versions`)
  // would add a second endpoint outside that contract. Omitting `documentId` creates a new
  // document from this upload; supplying it targets that document's version chain.
  //
  // Deliberately left member-accessible, unlike `SourcesController.create`'s admin gate on
  // `sourceClass`: a connector source configures where evidence comes from for the whole tenant,
  // while `dto.sourceClass` here only declares what a file the uploader already chose to add is —
  // no more consequential than the upload itself, which is already ungated. Gating it would leave
  // a Member able to add unclassified evidence but not to say what it is, so every browser upload
  // stayed unclassified regardless — the exact gap this endpoint exists to close.
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
        sourceClass: { type: 'string' },
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
      await this.documentsService.upload(file, dto, user.tenantId, {
        sourceClass: dto.sourceClass,
      }),
    );
  }

  @Get()
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiResponse(documentsApiExamples.list)
  async list(
    @Query() query: ListDocumentsRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<WithCountResponseDto<DocumentResponseDto>> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const { docs, count } = await this.documentsService.list(query, user.tenantId);

    return { docs: docs.map((doc) => toResponseDto(DocumentResponseDto, doc)), count };
  }

  // MUST be declared above `@Get(':id')` — `:id` matches a single path segment, and 'events' here
  // is also a single segment, so a request to `/documents/events` would otherwise be captured by
  // `:id` (id='events') and this route would be unreachable. `versions/:versionId/content` and
  // `versions/:versionId/chunks` below never collide with `:id` regardless of order — both are
  // multi-segment literal-prefixed patterns, not a bare `:id`. No `@HttpCode` here: `@Sse()` owns
  // the response status and streaming headers itself. No `@Header()` for
  // Cache-Control/X-Accel-Buffering either — see `WorkflowRunsController.streamRun`'s identical
  // note: `@nestjs/core`'s `SseStream` already sends both, unconditionally, on every SSE response.
  // `@SkipThrottle()` exempts this route from both global throttler guards (`UserThrottlerGuard`
  // and the pre-auth perimeter `PreAuthThrottlerGuard`) entirely — an unbounded, unthrottled,
  // long-lived connection with a `DOCUMENTS_STREAM_INTERVAL_MS` DB tick. Per-tenant
  // and per-user open-connection caps are enforced below (`acquireStreamSlot`, config'd via
  // `TypedConfigService.sse`), refusing with 429 once a tenant or user already has its configured
  // number of streams open. That bounds concurrency, not request rate — a burst of opens that each
  // close immediately never pushes concurrency past what a single lingering one would, so this is
  // not a throttling substitute; it exists to cap how much of the process's connection budget one
  // tenant or user can hold at once.
  @Sse('events')
  @Version('1')
  @SkipThrottle()
  @ApiResponse(documentsApiExamples.stream)
  @ApiResponse(documentsApiExamples.streamConnectionLimitExceeded)
  streamEvents(
    @Query() pagination: PaginationRequestDto,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Observable<MessageEvent> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    const release = acquireStreamSlot(user.tenantId, user.userId, this.config.sse);

    return this.documentsService
      .streamList(user.tenantId, user.userId, pagination)
      .pipe(finalize(release));
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

  // Route-scoped, not a third global APP_GUARD — same reasoning as `ApprovalsController.decide`'s
  // identical comment: Nest runs global guards (JwtAuthGuard) before route-scoped ones, so
  // request.user is already populated by the time this guard reads it, and gating only this one
  // irreversible route avoids coupling every other document route to a role check it doesn't need.
  @Delete(':id')
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @RequireRole(UserRole.Admin)
  @ApiResponse(documentsApiExamples.deleted)
  @ApiResponse(documentsApiExamples.forbidden)
  @ApiResponse(documentsApiExamples.notFound)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedRequest['user'],
  ): Promise<void> {
    if (!user) {
      throw new UnauthorizedException('No token provided');
    }

    await this.documentsService.remove(id, user.userId, user.tenantId);
  }
}

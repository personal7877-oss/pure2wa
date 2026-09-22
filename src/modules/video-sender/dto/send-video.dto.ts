import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../message/dto/send-message.dto';

/**
 * multipart/form-data body for POST /sessions/:sessionId/video-sender/send. The video file itself
 * travels as the `video` field (see FileInterceptor on the controller) — this DTO only covers the
 * accompanying form fields.
 */
export class SendVideoJobDto {
  @ApiProperty({
    description: 'Recipient chat IDs, comma-separated in a single string (form field, not JSON array).',
    example: '628123456789@c.us,628999888777@c.us',
  })
  // multipart/form-data delivers every field as a string; split+trim here rather than asking the
  // caller to pre-format a JSON array inside a form field.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(v => v.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Each recipient must be a valid chat JID' })
  chatIds!: string[];

  @ApiPropertyOptional({ description: 'Optional caption sent with the video.', maxLength: MESSAGE_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  caption?: string;
}

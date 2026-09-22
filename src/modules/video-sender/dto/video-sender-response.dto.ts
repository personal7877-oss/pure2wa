import { ApiProperty } from '@nestjs/swagger';

export class VideoSenderRecipientResultDto {
  @ApiProperty({ example: '628123456789@c.us' })
  chatId!: string;

  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ required: false, example: '3EB0ABC123' })
  messageId?: string;

  @ApiProperty({ required: false, example: 'Session is not active. Start the session first.' })
  error?: string;
}

export class VideoSenderResponseDto {
  @ApiProperty({ description: 'Compressed video size in bytes, as reported by Cloudinary.', example: 24117248 })
  compressedBytes!: number;

  @ApiProperty({ type: [VideoSenderRecipientResultDto] })
  results!: VideoSenderRecipientResultDto[];
}

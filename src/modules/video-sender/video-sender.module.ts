import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { SessionModule } from '../session/session.module';
import { VideoSenderController } from './video-sender.controller';
import { VideoSenderService } from './video-sender.service';

@Module({
  imports: [MessageModule, SessionModule],
  controllers: [VideoSenderController],
  providers: [VideoSenderService],
})
export class VideoSenderModule {}

import { NotificationProvider } from "../../services/notification.service";
import { smtpService } from "../smtp.service";
import logger from "../../utils/logger";
import https from "https";

export class SmtpEmailProvider implements NotificationProvider {
  async send(to: string, message: string): Promise<boolean> {
    return smtpService.sendMail({
      to,
      subject: "AnchorPoint Notification",
      text: message,
    });
  }
}

export class ConsoleEmailProvider implements NotificationProvider {
  async send(to: string, message: string): Promise<boolean> {
    logger.info(`[MOCK EMAIL] To: ${to} | Message: ${message}`);
    return true;
  }
}

export class ConsoleSmsProvider implements NotificationProvider {
  async send(to: string, message: string): Promise<boolean> {
    logger.info(`[MOCK SMS] To: ${to} | Message: ${message}`);
    return true;
  }
}

export class ConsolePushProvider implements NotificationProvider {
  async send(to: string, message: string): Promise<boolean> {
    logger.info(`[MOCK PUSH] To: ${to} | Message: ${message}`);
    return true;
  }
}

export class FcmPushProvider implements NotificationProvider {
  async send(to: string, message: string): Promise<boolean> {
    try {
      const fcmServerKey = process.env.FCM_SERVER_KEY;
      if (!fcmServerKey) {
        logger.warn("FCM_SERVER_KEY not configured, push notification not sent");
        return false;
      }

      const payload = JSON.stringify({
        notification: {
          title: "AnchorPoint Notification",
          body: message,
        },
        to,
      });

      const options = {
        hostname: "fcm.googleapis.com",
        port: 443,
        path: "/fcm/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `key=${fcmServerKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      return new Promise((resolve) => {
        const req = https.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              logger.info(`FCM push notification sent successfully to ${to}`);
              resolve(true);
            } else {
              logger.error(`FCM push notification failed: ${res.statusCode} ${data}`);
              resolve(false);
            }
          });
        });

        req.on("error", (error) => {
          logger.error("FCM push notification error:", error);
          resolve(false);
        });

        req.write(payload);
        req.end();
      });
    } catch (error) {
      logger.error("Error sending FCM push notification:", error);
      return false;
    }
  }
}

export function createEmailProvider(): NotificationProvider {
  return smtpService.isConfigured()
    ? new SmtpEmailProvider()
    : new ConsoleEmailProvider();
}

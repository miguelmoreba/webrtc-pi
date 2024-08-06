import winston from 'winston';

const isDevelopment = false;

const loggerTransports: winston.transport[] = [
    new winston.transports.Console() as winston.transport,
];

// Conditionally add CloudWatch transport if not in development mode
// if (!isDevelopment) {
//     const cloudWatchConfig = {
//         logGroupName: 'your-log-group',
//         logStreamName: 'your-log-stream',
//         awsRegion: process.env.AWS_REGION,
//         awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
//         awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//         jsonMessage: true, // Ensures messages are JSON formatted
//         uploadRate: 2000,  // Time in milliseconds to batch logs before uploading
//     };

//     const cloudWatchTransport = new WinstonCloudWatch(cloudWatchConfig);
//     loggerTransports.push(cloudWatchTransport as winston.transport);
// }

export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level}]: ${message}`;
        })
    ),
    transports: loggerTransports
});

export const log = (message: any, level?: string) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
};

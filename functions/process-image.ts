import { MetricUnits } from '@aws-lambda-powertools/metrics';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Subsegment } from 'aws-xray-sdk-core';
import middy from '@middy/core';

import { logger, metrics, tracer } from './common/powertools';
import {
  getFileId,
  getObjectKey,
  ItemsListKeeper,
  timedOutAsyncOperation,
  TimeoutErr,
  TransformParams,
} from './common/processing-utils';
import { getImageTransformParams } from './common/processing-utils';
import { s3ClientV3 } from './common/s3-client';
import { saveAssetToS3 } from './common/s3-utils';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer';
import { faultInjection } from './common/middleware/faultInjection';
import { injectLambdaContext } from '@aws-lambda-powertools/logger';

const dynamoDBTableFiles = process.env.TABLE_NAME_FILES || '';
const s3BucketFiles = process.env.BUCKET_NAME_FILES || '';
let itemsProcessorHelper: ItemsListKeeper;

const getOriginalObject = async (key: string, bucketName: string) => {
  const res = await s3ClientV3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );
  const stream = res.Body! as Readable;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
};

const processImage = async (fileId: string, originalImage: Buffer, {
  width,
  height
}: TransformParams, mainSubSegment: Subsegment) => {
  try {
    // @ts-ignore
    const resizedImg = await sharp(originalImage)
      .resize(width, height)
      .toFormat('webp')
      .toBuffer();

    return resizedImg;
  } catch (err) {
    logger.error(`Error processing image`, {
      details: fileId,
      error: err,
    });
    throw err;
  }
};

const processOne = async (fileId: string, objectKey: string, mainSubSegment: Subsegment) => {
  const newFileKey = `transformed/image/webp/${fileId}.webp`;

  const originalImage = await getOriginalObject(objectKey, s3BucketFiles);

  const transformParams = await getImageTransformParams({
    id: fileId,
    tableName: dynamoDBTableFiles,
  });

  const processedImage = await processImage(
    fileId,
    originalImage,
    transformParams,
    mainSubSegment
  );

  await saveAssetToS3({
    key: newFileKey,
    bucketName: s3BucketFiles,
    body: processedImage,
  });
  logger.info('Saved image on S3', { details: newFileKey });

  metrics.addMetric('processedImages', MetricUnits.Count, 1);
};

const lambdaHandler = async (event: SQSEvent, context: Context) => {
  itemsProcessorHelper = new ItemsListKeeper();

  const mainSubsegment = tracer.getSegment() as Subsegment;

  const messageProcesses = Promise.all(
    event.Records.map(async (record: SQSRecord) => {
      const { body, messageId } = record;
      const objectKey = getObjectKey(body);
      const fileId = getFileId(objectKey);

      try {
        await itemsProcessorHelper.markStarted({
          id: fileId,
          msgId: messageId,
        });
        await processOne(fileId, objectKey, mainSubsegment);
        await itemsProcessorHelper.markProcessed(fileId);
      } catch (err) {
        await itemsProcessorHelper.markFailed(fileId);
      }
    })
  );

  try {
    await timedOutAsyncOperation(
      messageProcesses,
      context.getRemainingTimeInMillis() - 5000
    );
  } catch (err) {
    if (err !== TimeoutErr) {
      logger.error('An unexpected error occurred', err as Error);
    }
    logger.error('Function will timeout in', {
      details: context.getRemainingTimeInMillis(),
    });
  } finally {
    const batchItemFailures: { itemIdentifier: string }[] = [];

    // Get all items that were failed & add them to the `batchItemFailures`
    const failed = itemsProcessorHelper.getFailed();
    for (const [ _, msgId ] of failed) {
      batchItemFailures.push({ itemIdentifier: msgId });
    }

    // Get items still left to process
    const unprocessed = itemsProcessorHelper.getUnprocessed();

    // Mark each one as failed & add it to `batchItemFailures` so they are sent back to the queue/DLQ
    for await (const [ id, msgId ] of unprocessed) {
      await itemsProcessorHelper.markFailed(id);
      batchItemFailures.push({ itemIdentifier: msgId });
    }

    if (batchItemFailures.length) {
      logger.info('Items to be sent back to queue/DLQ', {
        details: batchItemFailures,
      });

      return batchItemFailures;
    } else {
      logger.info('All items processed successfully');
    }

    return;
  }
};

export const handler = middy(lambdaHandler)
  .use(captureLambdaHandler(tracer))
  .use(faultInjection({ logger, tracer }))
  .use(injectLambdaContext(logger));

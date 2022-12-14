import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { Rule, Match } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { FunctionsConstruct } from './functions-construct';
import { QueuesConstruct } from './queues-construct';
import { ParametersConstruct } from './parameters-construct';

interface VideoProcessingProps {
  landingZoneBucketName: string
}

export class VideoProcessing extends Construct {
  public readonly functions: FunctionsConstruct;
  public readonly parameters: ParametersConstruct;
  public readonly queues: QueuesConstruct;

  public constructor(scope: Construct, id: string, props: VideoProcessingProps) {
    super(scope, id);

    const { landingZoneBucketName } = props;
    const videoProcessingTimeout = Duration.seconds(120);

    this.functions = new FunctionsConstruct(this, 'functions-construct', {
      landingZoneBucketName,
      videoProcessingTimeout,
    });

    this.queues = new QueuesConstruct(this, 'queues-construct', {
      videoProcessingTimeout,
    });

    this.functions.resizeVideoFn.addEventSource(
      new SqsEventSource(this.queues.processingQueue, {
        batchSize: 1,
        enabled: true,
        reportBatchItemFailures: true,
      })
    );

    const videoProcessRule = new Rule(this, 'video-process', {
      eventPattern: {
        source: Match.anyOf('aws.s3'),
        detailType: Match.anyOf('Object Created'),
        detail: {
          bucket: {
            name: Match.anyOf(landingZoneBucketName),
          },
          object: {
            key: Match.anyOf(
              Match.prefix('uploads/video/mp4'),
              Match.prefix('uploads/video/webm')
            ),
          },
          reason: Match.anyOf('PutObject'),
        },
      },
    });
    videoProcessRule.addTarget(new SqsQueue(this.queues.processingQueue));

    this.parameters = new ParametersConstruct(this, 'parameters-construct', {});

    this.parameters.processVideoFailuresString.grantRead(
      this.functions.resizeVideoFn
    );

    this.functions.resizeVideoFn.addEnvironment(
      'FAILURE_INJECTION_PARAM',
      this.parameters.processVideoFailuresString.stringParameter.parameterName
    );
  }
}

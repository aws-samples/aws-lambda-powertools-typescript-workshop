import { Construct } from 'constructs';
import { Rule, Match } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { FunctionsConstruct } from './functions-construct';
import { QueuesConstruct } from './queues-construct';
import { ParametersConstruct } from './parameters-construct';

interface ImageProcessingProps {
  landingZoneBucketName: string
}

export class ImageProcessing extends Construct {
  public readonly functions: FunctionsConstruct;
  public readonly parameters: ParametersConstruct;
  public readonly queues: QueuesConstruct;

  public constructor(scope: Construct, id: string, props: ImageProcessingProps) {
    super(scope, id);

    const { landingZoneBucketName } = props;

    this.functions = new FunctionsConstruct(this, 'functions-construct', {
      landingZoneBucketName,
    });

    this.queues = new QueuesConstruct(this, 'queues-construct', {});

    this.functions.resizeImageFn.addEventSource(
      new SqsEventSource(this.queues.processingQueue, {
        batchSize: 1,
        enabled: true,
      })
    );

    const imageProcessRule = new Rule(this, 'image-process', {
      eventPattern: {
        source: Match.anyOf('aws.s3'),
        detailType: Match.anyOf('Object Created'),
        detail: {
          bucket: {
            name: Match.anyOf(landingZoneBucketName),
          },
          object: {
            key: Match.anyOf(
              Match.prefix('uploads/image/jpeg'),
              Match.prefix('uploads/image/png')
            ),
          },
          reason: Match.anyOf('PutObject'),
        },
      },
    });
    imageProcessRule.addTarget(new SqsQueue(this.queues.processingQueue));

    this.parameters = new ParametersConstruct(this, 'parameters-construct', {});

    this.parameters.processImageFailuresString.grantRead(
      this.functions.resizeImageFn
    );

    this.functions.resizeImageFn.addEnvironment(
      'FAILURE_INJECTION_PARAM',
      this.parameters.processImageFailuresString.stringParameter.parameterName
    );
  }
}
import { Stack, StackProps, CfnOutput, aws_ssm as ssm, aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CfnGroup } from "aws-cdk-lib/aws-resourcegroups";
import { Frontend } from "./frontend";
import { ContentHubRepo } from "./content-hub-repository";
import { ImageProcessing } from "./image-processing";
import { VideoProcessing } from "./video-processing";
import { TrafficGenerator } from "./traffic-generator";
import {
  landingZoneBucketNamePrefix,
  powertoolsServiceName,
  environment,
} from "./constants";

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new CfnGroup(this, "resource-group", {
      name: `lambda-powertools-workshop-${environment}`,
      description: "Resource Group for aws-lambda-powertools-workshop service",
      resourceQuery: {
        query: {
          tagFilters: [
            {
              key: "Service",
              values: [powertoolsServiceName],
            },
          ],
        },
        type: "TAG_FILTERS_1_0",
      },
    });

    const landingZoneBucketName = `${landingZoneBucketNamePrefix}-${
      Stack.of(this).account
    }-${environment}`;

    const frontend = new Frontend(this, "frontend", {});

    const failureLambdaParameter = new ssm.StringParameter(this, "failureLambdaParameter", {
          stringValue: '{"isEnabled": false, "failureMode": "denylist", "rate": 1, "minLatency": 100, "maxLatency": 400, "exceptionMsg": "Exception message!", "statusCode": 404, "diskSpace": 100, "denylist": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]}',
        }
    );

    // Content Hub Repository
    const contentHubRepo = new ContentHubRepo(this, "content-hub-repo", {
      userPool: frontend.auth.userPool,
      landingZoneBucketName,
    });
    frontend.addApiBehavior(contentHubRepo.api.domain);

    // Image Processing Module
    const imageProcessing = new ImageProcessing(this, "image-processing", {
      landingZoneBucketName,
    });
    contentHubRepo.storage.grantReadWrite(
      imageProcessing.functions.resizeImageFn
    );
    contentHubRepo.storage.grantReadWriteDataOnTable(
      imageProcessing.functions.resizeImageFn
    );
    contentHubRepo.api.api.grantMutation(
      imageProcessing.functions.resizeImageFn,
      "updateFileStatus"
    );
    imageProcessing.functions.resizeImageFn.addEnvironment(
      "APPSYNC_ENDPOINT",
      `https://${contentHubRepo.api.domain}/graphql`
    );
    imageProcessing.functions.resizeImageFn.addEnvironment(
        "FAILURE_INJECTION_PARAM",
        failureLambdaParameter.parameterName
    );
    failureLambdaParameter.grantRead(imageProcessing.functions.resizeImageFn);

    // Video Processing Module
    const videoProcessing = new VideoProcessing(this, "video-processing", {
      landingZoneBucketName,
    });
    contentHubRepo.storage.grantReadWrite(
      videoProcessing.functions.resizeVideoFn
    );
    contentHubRepo.storage.grantReadWriteDataOnTable(
      videoProcessing.functions.resizeVideoFn
    );
    contentHubRepo.api.api.grantMutation(
      videoProcessing.functions.resizeVideoFn,
      "updateFileStatus"
    );
    contentHubRepo.functions.getPresignedUploadUrlFn.addEnvironment(
        "FAILURE_INJECTION_PARAM",
        failureLambdaParameter.parameterName
    );
    failureLambdaParameter.grantRead(contentHubRepo.functions.getPresignedUploadUrlFn);

    videoProcessing.functions.resizeVideoFn.addEnvironment(
      "APPSYNC_ENDPOINT",
      `https://${contentHubRepo.api.domain}/graphql`
    );
    videoProcessing.functions.resizeVideoFn.addEnvironment(
        "FAILURE_INJECTION_PARAM",
        failureLambdaParameter.parameterName
    );
    failureLambdaParameter.grantRead(videoProcessing.functions.resizeVideoFn);

    // Traffic Generator Component
    const trafficGenerator = new TrafficGenerator(
      this,
      "traffic-generator",
      {}
    );
    trafficGenerator.functions.usersGeneratorFn.addEnvironment(
      "COGNITO_USER_POOL_CLIENT_ID",
      frontend.auth.userPoolClient.userPoolClientId
    );
    trafficGenerator.functions.trafficGeneratorFn.addEnvironment(
      "COGNITO_USER_POOL_ID",
      frontend.auth.userPool.userPoolId
    );
    trafficGenerator.functions.trafficGeneratorFn.addEnvironment(
      "COGNITO_USER_POOL_CLIENT_ID",
      frontend.auth.userPoolClient.userPoolClientId
    );
    trafficGenerator.functions.trafficGeneratorFn.addEnvironment(
      "API_URL",
      `https://${contentHubRepo.api.domain}/graphql`
    );
    frontend.auth.userPool.grant(
      trafficGenerator.functions.trafficGeneratorFn,
      "cognito-idp:AdminInitiateAuth"
    );

    new CfnOutput(this, "AWSRegion", {
      value: Stack.of(this).region,
    });
  }
}

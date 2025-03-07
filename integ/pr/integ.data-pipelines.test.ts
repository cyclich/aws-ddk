import path from "path";
import * as integration from "@aws-cdk/integ-tests-alpha";
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as glue_alpha from "@aws-cdk/aws-glue-alpha";
import { Construct } from "constructs";
import { RequireApproval } from "aws-cdk-lib/cloud-assembly-schema";

import { DataPipeline, GlueTransformStage, FirehoseToS3Stage, SqsToLambdaStage, GlueJobType } from "../../src";
import * as iam from "aws-cdk-lib/aws-iam";

interface DataPipelineTestStackProps extends cdk.StackProps {
  readonly testWithScheduledEvent?: boolean;
}

class DataPipelineTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataPipelineTestStackProps) {
    super(scope, id, props);
    const bucket = new s3.Bucket(this, "Bucket", {removalPolicy: cdk.RemovalPolicy.DESTROY});

    const firehoseToS3Stage = new FirehoseToS3Stage(this, `${id} Firehose To S3 Stage`, { s3Bucket: bucket });

    const sqsToLambdaStage = new SqsToLambdaStage(this, `${id} SQS To Lambda Stage`, {
      lambdaFunctionProps: {
        code: lambda.Code.fromInline("def lambda_handler(event, context): return 200"),
        handler: "lambda_function.lambda_handler",
        memorySize: 512,
        runtime: lambda.Runtime.PYTHON_3_9,
      },
    });

    const glueIamRole = new iam.Role(this, "GlueRole", {
      assumedBy: new iam.ServicePrincipal("glue.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole")],
    });

    const glueTransformStage = new GlueTransformStage(this, `${id}Glue Transform Stage`, {
      jobProps: {
        glueJobType: GlueJobType.PYTHON_SHELL_JOB,
        glueJobProperties: {
          script: glue_alpha.Code.fromAsset(path.join(__dirname, "/src/glue_script.py")),
          glueVersion: glue_alpha.GlueVersion.V1_0,
          pythonVersion: glue_alpha.PythonVersion.THREE,
          role: glueIamRole,
        }
      },
      crawlerName: "dummy-crawler",
    })

    const pipeline = new DataPipeline(this, `${id} Pipeline`, {});

    if (props.testWithScheduledEvent) {
      pipeline.addNotifications().addStage({ stage: firehoseToS3Stage }).addStage({ stage: sqsToLambdaStage }).addStage({ stage: glueTransformStage, schedule: events.Schedule.rate(cdk.Duration.minutes(5))});
    }
    else {
      pipeline.addNotifications().addStage({ stage: firehoseToS3Stage }).addStage({ stage: sqsToLambdaStage }).addStage({ stage: glueTransformStage });
    }

  }
}

const app = new cdk.App();
new integration.IntegTest(app, "Sqs Lambda Stage Integration Tests", {
    testCases: [
      new DataPipelineTestStack(app, "DataPipelineBasic", {}),
      new DataPipelineTestStack(app, "DataPipelineScheduleEvent", {
        testWithScheduledEvent: true,
      }),
    ],
    diffAssets: true,
    stackUpdateWorkflow: true,
    cdkCommandOptions: {
      deploy: {
        args: {
          requireApproval: RequireApproval.NEVER,
          json: true,
        },
      },
      destroy: {
        args: {
          force: true,
        },
      },
    },
});

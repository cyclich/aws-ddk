import * as firehose from "@aws-cdk/aws-kinesisfirehose-alpha";
import * as destinations from "@aws-cdk/aws-kinesisfirehose-destinations-alpha";
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kinesis from "aws-cdk-lib/aws-kinesis";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { overrideProps } from "../core";
import { S3Factory } from "../core/s3-factory";
import { DataStage, DataStageProps } from "../pipelines/stage";

/**
 * Properties of the Firehose Delivery stream to be created.
 */
export interface DeliveryStreamProps {
  /**
   * The destinations that this delivery stream will deliver data to.
   *
   * Only a singleton array is supported at this time.
   */
  readonly destinations?: firehose.IDestination[];
  /**
   * A name for the delivery stream.
   *
   * @default - a name is generated by CloudFormation.
   */
  readonly deliveryStreamName?: string;
  /**
   * Indicates the type of customer master key (CMK) to use for server-side encryption, if any.
   *
   * @default StreamEncryption.UNENCRYPTED - unless `encryptionKey` is provided, in which case this will be implicitly set to `StreamEncryption.CUSTOMER_MANAGED`
   */
  readonly encryption?: firehose.StreamEncryption;
  /**
   * Customer managed key to server-side encrypt data in the stream.
   *
   * @default - no KMS key will be used; if `encryption` is set to `CUSTOMER_MANAGED`, a KMS key will be created for you
   */
  readonly encryptionKey?: kms.IKey;
  /**
   * The IAM role associated with this delivery stream.
   *
   * Assumed by Kinesis Data Firehose to read from sources and encrypt data server-side.
   *
   * @default - a role will be created with default permissions.
   */
  readonly role?: iam.IRole;
  /**
   * The Kinesis data stream to use as a source for this delivery stream.
   *
   * @default - data must be written to the delivery stream via a direct put.
   */
  readonly sourceStream?: kinesis.IStream;
}

/**
 * Properties for `FirehoseToS3Stage`.
 */
export interface FirehoseToS3StageProps extends DataStageProps {
  /**
   * Preexisting S3 Bucket to use as a destination for the Firehose Stream.
   * If no bucket is provided, a new one is created.
   *
   * Amazon EventBridge notifications must be enabled on the bucket in order
   * for this stage to produce events after its completion.
   */
  readonly s3Bucket?: s3.IBucket;
  /**
   * Properties of the S3 Bucket to be created as a delivery destination.
   *
   * Amazon EventBridge notifications must be enabled on the bucket in order
   * for this stage to produce events after its completion.
   */
  readonly s3BucketProps?: s3.BucketProps;
  /**
   * Firehose Delivery stream.
   * If no stram is provided, a new one is created.
   */
  readonly firehoseDeliveryStream?: firehose.DeliveryStream;
  /**
   * Properties of the Firehose Delivery stream to be created.
   */
  readonly firehoseDeliveryStreamProps?: DeliveryStreamProps;
  /**
   * Props for defining an S3 destination of a Kinesis Data Firehose delivery stream.
   */
  readonly kinesisFirehoseDestinationsS3BucketProps?: destinations.S3BucketProps;
  /**
   * A prefix that Kinesis Data Firehose evaluates and adds to records before writing them to S3.
   * This prefix appears immediately following the bucket name.
   * @default “YYYY/MM/DD/HH”
   */
  readonly dataOutputPrefix?: string;
  /**
   * Add Kinesis Data Stream to front Firehose Delivery.
   * @default false
   */
  readonly dataStreamEnabled?: boolean;
  /**
   * Preexisting Kinesis Data Stream to use in stage before Delivery Stream.
   * Setting this parameter will override any creation of Kinesis Data Streams
   * in this stage.
   * The `dataStreamEnabled` parameter will have no effect.
   */
  readonly dataStream?: kinesis.Stream;
  /**
   * Threshold for Cloudwatch Alarm created for this stage.
   * @default 900
   */
  readonly deliveryStreamDataFreshnessErrorsAlarmThreshold?: number;
  /**
   * Evaluation period value for Cloudwatch alarm created for this stage.
   * @default 1
   */
  readonly deliveryStreamDataFreshnessErrorsEvaluationPeriods?: number;
}

/**
 * DDK Kinesis Firehose Delivery stream to S3 stage, with an optional Kinesis Data Stream.
 */
export class FirehoseToS3Stage extends DataStage {
  readonly targets?: events.IRuleTarget[];
  readonly eventPattern?: events.EventPattern;

  readonly bucket: s3.IBucket;
  readonly deliveryStream: firehose.DeliveryStream;
  readonly dataStream?: kinesis.Stream;

  /**
   * Constructs `FirehoseToS3Stage`.
   * @param scope Scope within which this construct is defined.
   * @param id Identifier of the stage.
   * @param props Properties for the stage.
   */
  constructor(scope: Construct, id: string, props: FirehoseToS3StageProps) {
    super(scope, id, props);

    if (props.s3Bucket) {
      this.bucket = props.s3Bucket;
    } else if (props.s3BucketProps) {
      this.bucket = S3Factory.bucket(this, "Stage Bucket", {
        ...props.s3BucketProps,
        eventBridgeEnabled: true,
      });
    } else {
      throw TypeError("'s3Bucket' or 's3BucketProps' must be set to instantiate this stage");
    }

    if (props.dataStreamEnabled == true && !props.dataStream) {
      this.dataStream = new kinesis.Stream(this, "Data Stream", {});
    } else if (props.dataStreamEnabled != false && props.dataStream) {
      this.dataStream = props.dataStream;
    }

    const destinationsBucketProps = overrideProps(
      {
        compression: destinations.Compression.GZIP,
        bufferingInterval: cdk.Duration.seconds(300),
        bufferingSize: cdk.Size.mebibytes(5),
      },
      {
        ...(props.kinesisFirehoseDestinationsS3BucketProps ?? {}),
        dataOutputPrefix: props.dataOutputPrefix,
      },
    );
    this.deliveryStream = props.firehoseDeliveryStream
      ? props.firehoseDeliveryStream
      : new firehose.DeliveryStream(this, "Delivery Stream", {
          destination: new destinations.S3Bucket(this.bucket, destinationsBucketProps),
          source: this.dataStream ? new firehose.KinesisStreamSource(this.dataStream) : undefined,
          ...props.firehoseDeliveryStreamProps,
        });
    const dataOutputPrefix: string = destinationsBucketProps.dataOutputPrefix;

    this.addAlarm("Data Freshness Errors", {
      metric: this.deliveryStream.metric("DeliveryToS3.DataFreshness", {
        period: destinationsBucketProps.bufferingInterval,
        statistic: "Maximum",
      }),
      threshold: props.deliveryStreamDataFreshnessErrorsAlarmThreshold,
      evaluationPeriods: props.deliveryStreamDataFreshnessErrorsEvaluationPeriods,
    });

    const eventDetail = {
      bucket: { name: [this.bucket.bucketName] },
      ...(dataOutputPrefix && { object: { key: [{ prefix: dataOutputPrefix }] } }),
    };

    this.eventPattern = {
      source: ["aws.s3"],
      detail: eventDetail,
      detailType: ["Object Created"],
    };
  }
}

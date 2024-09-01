import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { snsLogger } from "./functions/snsLogger/resource";
import * as iot from 'aws-cdk-lib/aws-iot';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iotEvents from "aws-cdk-lib/aws-iotevents";
import * as sns from 'aws-cdk-lib/aws-sns';

const backend = defineBackend({
  auth,
  data,
  snsLogger
});

// 参考1をもとに参考2を作ってみた

// 参考1：AWS IoT EventsをAWS CDKで作ってみた
// https://dev.classmethod.jp/articles/aws-iot-events-aws-cdk/

// 参考2：IoTデバイスのイベント検出とアクション実行がラクチンに！！AWS IoT EventsがGAされました
// https://dev.classmethod.jp/articles/aws-iot-events-ga/


/*
  IoT CoreのMQTT テストクライアントから以下のJSONを投げればテスト可能
  pressureが71以上で Dangerousステートへ
  pressureが70以下でIoT Eventsの変数が減少し、Normalステートへ

  Topic名： motors/A32/status    (A32は任意)
  ペイロード：
  {
    "motorid": "Fulton-A32",
    "sensorData": {
      "pressure": 23,
      "temperature": 47
    }
  }
*/


const customResourceStack = backend.createStack('CustomResourceStack');

// IoT Eventsから通知するSNS
const sns_topic = new sns.Topic(customResourceStack, "CdkNotificationSnsTopic", {
  topicName: "CdkNotificationSnsTopic"
});

// SNSの通知先(Eメール)
new sns.Subscription(customResourceStack, "CdkNotificationSnsSubscription1", {
  endpoint: "hoge@example.com",
  protocol: sns.SubscriptionProtocol.EMAIL,
  topic: sns_topic,
});

// SNSの通知先(Lambda)
new sns.Subscription(customResourceStack, "CdkNotificationSnsSubscription2", {
  endpoint: backend.snsLogger.resources.lambda.functionArn,
  protocol: sns.SubscriptionProtocol.LAMBDA,
  topic: sns_topic,
});

// Lambdaのアクセス権限を設定
// const iamArnPrincipal = new iam.ArnPrincipal(sns_topic.topicArn);
const iotServicePrincipal = new iam.ServicePrincipal('sns.amazonaws.com');
backend.snsLogger.resources.lambda.grantInvoke(iotServicePrincipal);


// IoT Eventsで受け取る値の設定、設定していない値は受け取れない
const eventsInput = new iotEvents.CfnInput(customResourceStack, "CdkPressureInput", {
  inputName: "CdkPressureInput",
  inputDefinition: {
    attributes: [
      { jsonPath: "sensorData.pressure" },
      { jsonPath: "motorid" },
    ],
  },
});

// IoT CoreトピックルールからIoT Eventsを呼び出すためのIAMロール
const topic_rule_role = new iam.Role(customResourceStack, "CdkIotTopicRuleRole", {
  assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
  inlinePolicies: {
    "iot-event-invoke": new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "iotevents:BatchPutMessage"
          ],
          resources: [
            `arn:aws:iotevents:${customResourceStack.region}:${customResourceStack.account}:input/PressureInput`
          ]
        })
      ]
    })
  }
});

// IoT Coreトピックルール
const topic_rule = new iot.CfnTopicRule(customResourceStack, "CdkIotTopicRule", {
  topicRulePayload: {
    sql: "SELECT *, topic(2) as motorid FROM 'motors/+/status'",
    actions: [
      {
        iotEvents: {
          inputName: eventsInput.inputName!,
          roleArn: topic_rule_role.roleArn,
        },
      }
    ]
  }
});

// 探知機モデルのIAMロール
const detector_role = new iam.Role(customResourceStack, "CdkMotorDetectorModelRole", {
  assumedBy: new iam.ServicePrincipal("iotevents.amazonaws.com"),
  managedPolicies: [
    {
      managedPolicyArn: "arn:aws:iam::aws:policy/AmazonSNSFullAccess",
    },
  ],
});


// 検出器モデルの定義。この部分の実装はGUIと併用することで効率的にモデルの作成/取り込みができる
// GUIからJSONエクスポートして、detectorModelDefinitionの内部を全文コピペでOK
const detector_definition = {
  "states": [
    {
      "stateName": "Normal",
      "onInput": {
        "events": [],
        "transitionEvents": [
          {
            "eventName": "Overpressurized",
            "condition": "$input.PressureInput.sensorData.pressure > 70",
            "actions": [
              {
                "setVariable": {
                  "variableName": "pressureThresholdBreached",
                  "value": "$variable.pressureThresholdBreached + 3"
                }
              }
            ],
            "nextState": "Dangerous"
          }
        ]
      },
      "onEnter": {
        "events": [
          {
            "eventName": "init",
            "condition": "true",
            "actions": [
              {
                "setVariable": {
                  "variableName": "pressureThresholdBreached",
                  "value": "0"
                }
              }
            ]
          }
        ]
      },
      "onExit": {
        "events": []
      }
    },
    {
      "stateName": "Dangerous",
      "onInput": {
        "events": [
          {
            "eventName": "Overpressurized",
            "condition": "$input.PressureInput.sensorData.pressure > 70",
            "actions": [
              {
                "setVariable": {
                  "variableName": "pressureThresholdBreached",
                  "value": "$variable.pressureThresholdBreached + 3"
                }
              }
            ]
          },
          {
            "eventName": "Pressure Okay",
            "condition": "$input.PressureInput.sensorData.pressure <= 70",
            "actions": [
              {
                "setVariable": {
                  "variableName": "pressureThresholdBreached",
                  "value": "$variable.pressureThresholdBreached - 1"
                }
              }
            ]
          }
        ],
        "transitionEvents": [
          {
            "eventName": "BackToNormal",
            "condition": "$input.PressureInput.sensorData.pressure <= 70 && $variable.pressureThresholdBreached <= 0",
            "actions": [],
            "nextState": "Normal"
          }
        ]
      },
      "onEnter": {
        "events": [
          {
            "eventName": "Pressure Threshold Breached",
            "condition": "$variable.pressureThresholdBreached > 1",
            "actions": [
              {
                "sns": {
                  "targetArn": sns_topic.topicArn
                }
              }
            ]
          }
        ]
      },
      "onExit": {
        "events": [
          {
            "eventName": "Normal Pressure Restored",
            "condition": "true",
            "actions": [
              {
                "sns": {
                  "targetArn": sns_topic.topicArn
                }
              }
            ]
          }
        ]
      }
    }
  ],
  "initialStateName": "Normal"
}

// 検出器モデルの作成
const detector_model = new iotEvents.CfnDetectorModel(customResourceStack, "CdkMotorDetectorModel", {
  detectorModelDefinition: detector_definition,
  detectorModelName: "CdkMotorDetectorModel",
  key: "motorid",
  evaluationMethod: "BATCH",
  roleArn: detector_role.roleArn,
});


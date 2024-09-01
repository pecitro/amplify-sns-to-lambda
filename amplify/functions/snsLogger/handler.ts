import type { Handler } from 'aws-lambda';

export const handler: Handler = async (event) => {
  // TODO implement
  const sns_message = event.Records[0].Sns.Message;

  console.log(sns_message);
  console.log(JSON.parse(sns_message));


  const response = {
    statusCode: 200,
    body: JSON.stringify('Hello from Lambda!'),
  };
  return response;
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cfn from '@aws-cdk/aws-cloudformation';
import * as cdk from '@aws-cdk/core';
import * as cognito from '@aws-cdk/aws-cognito';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import * as elasticsearch from '@aws-cdk/aws-elasticsearch';
import * as customResources from '@aws-cdk/custom-resources';

export interface ElasticsearchStackProps {
  ccpUrl: string,
}

interface CognitoPoolStore {
  identityPool: string,
  userPool: string
}

interface ElasticsearchStackIamResources {
  authRole: iam.Role,
  esRole: iam.Role,
  elasticsearchAccessPolicy: iam.PolicyDocument
}

export class ElasticSearchStack extends cfn.NestedStack {
  private ccpUrl: string;

  private ccpName: string;

  public elasticsearchArn: string;

  private elasticsearchDomain: elasticsearch.CfnDomain;

  private cognitoPools: CognitoPoolStore;

  constructor(scope: cdk.Construct, id: string, props: ElasticsearchStackProps) {
    super(scope, id);
    
    if(process.env.ES_DOMAIN_ENDPOINT != undefined) {
      //future releases should have both paths use the Domain construct
      this.elasticsearchArn = elasticsearch.Domain.fromDomainEndpoint(this, "Existing Domain", process.env.ES_DOMAIN_ENDPOINT).domainArn.replace('search-', '');
    } else {
      this.ccpUrl = props.ccpUrl;
      // get a unique suffix from the second to last element of the stackId, e.g. 9e3a
      const suffix = cdk.Fn.select(3, cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', this.stackId))));
      
      // Get the name of the connect instance from the ccp url
      
      // Parsing depends on style of Connect URL being used (depends on when Connect resource was created)
      var substringPattern;

      // old-style URLs for Connect
      if (this.ccpUrl.includes('.awsapps.com')) {
        substringPattern = '.awsapps.com';
      } 
      // new-style URLs for Connect
      else if (this.ccpUrl.includes('.my.connect.aws')) {
        substringPattern = '.my.connect.aws';
      }
      else {
        throw new Error('Unsupported Connect URL format, expected "xxx.awsapps.com" or "xxx.my.connect.aws"!');
      }

      this.ccpName = this.ccpUrl.substring(
        this.ccpUrl.indexOf('//') + 2,
        this.ccpUrl.indexOf(substringPattern),
      );

      if (this.ccpName.length > 24) {
        this.ccpName = this.ccpName.substring(0, 24);
      }
      this.cognitoPools = this.createCognitoPools(suffix);
      const iamResources = this.createIamResources(this.cognitoPools.identityPool);
      this.elasticsearchDomain = this.createElasticsearchDomain(
        this.cognitoPools,
        iamResources,
      );
      this.elasticsearchArn = this.elasticsearchDomain.attrArn;
    }
  }

  private createCognitoPools(suffix: string) {
    const userPool = new cognito.CfnUserPool(this, 'userPool', {
      adminCreateUserConfig: {
        allowAdminCreateUserOnly: true,
      },
      policies: { passwordPolicy: { minimumLength: 8 } },
      usernameAttributes: ['email'],
      autoVerifiedAttributes: ['email'],
    });

    new cognito.CfnUserPoolDomain(this, 'cognitoDomain', {
      domain: `${this.ccpName.toLowerCase()}-${suffix}`,
      userPoolId: userPool.ref,
    });

    const idPool = new cognito.CfnIdentityPool(this, 'identityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [],
    });

    return {
      identityPool: idPool.ref,
      userPool: userPool.ref,
    };
  }

  private createIamResources(identityPool: string) {
    const authRole = new iam.Role(this, 'authRole', {
      assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
        StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool },
        'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
      }, 'sts:AssumeRoleWithWebIdentity'),
    });

    const esRole = new iam.Role(this, 'esRole', {
      assumedBy: new iam.ServicePrincipal('es.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonESCognitoAccess')],
    });

    const policy = new iam.PolicyDocument();
    policy.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.AccountPrincipal(cdk.Stack.of(this).account),
          new iam.ArnPrincipal(authRole.roleArn),
        ],
        actions: ['es:*'],
        resources: [`arn:aws:es:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:domain/*/*`],
      }),
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'userPoolRoleAttachment', {
      identityPoolId: identityPool,
      roles: {
        authenticated: authRole.roleArn,
      },
    });

    return {
      authRole,
      esRole,
      elasticsearchAccessPolicy: policy,
    };
  }

  private createElasticsearchDomain(
    cognitoPools: CognitoPoolStore,
    iamResources: ElasticsearchStackIamResources,
  ) {
    const elasticsearchDomain = new elasticsearch.CfnDomain(this, 'ElasticsearchDomain', {
      accessPolicies: iamResources.elasticsearchAccessPolicy,
      encryptionAtRestOptions: {
        enabled: true,
      },
      ebsOptions: {
        ebsEnabled: true,
        volumeSize: 1000,
        volumeType: 'gp2',
      },
      elasticsearchClusterConfig: {
        dedicatedMasterCount: 3,
        dedicatedMasterEnabled: true,
        dedicatedMasterType: 'c5.large.elasticsearch',
        instanceCount: 3,
        instanceType: 'r5.2xlarge.elasticsearch',
        zoneAwarenessEnabled: true,
        zoneAwarenessConfig: {
          availabilityZoneCount: 3,
        },
      },
      elasticsearchVersion: '7.9',
    });

    elasticsearchDomain.addPropertyOverride('CognitoOptions.Enabled', true);
    elasticsearchDomain.addPropertyOverride('CognitoOptions.IdentityPoolId', cognitoPools.identityPool);
    elasticsearchDomain.addPropertyOverride('CognitoOptions.RoleArn', iamResources.esRole.roleArn);
    elasticsearchDomain.addPropertyOverride('CognitoOptions.UserPoolId', cognitoPools.userPool);

    this.configureElasticsearchDomain(elasticsearchDomain);
    return elasticsearchDomain;
  }

  public getUserCreateUrl() {
    return this.cognitoPools ?
      `https://${this.region}.console.aws.amazon.com/cognito/users?region=${this.region}#/pool/${this.cognitoPools.userPool}/users`
      : 'Cognito User Pools are not deployed for existing ES domains';
  }

  public getKibanaUrl() {
    const domainEndpoint = process.env.ES_DOMAIN_ENDPOINT ? 
      process.env.ES_DOMAIN_ENDPOINT
      : this.elasticsearchDomain.attrDomainEndpoint;
    return `https://${domainEndpoint}/_plugin/kibana/`;
  }

  private configureElasticsearchDomain(elasticsearchDomain: elasticsearch.CfnDomain) {
    /*
    * Create our provider Lambda for the custom resource. This Lambda is responsible for configuring
    * our Kibana instance and updating relevant ES options (for example, configuring an ingest node)
    */
    const elasticsearchConfiurationLambda = new lambda.Function(this, 'ElasticsearchConfigurationLambda', {
      runtime: lambda.Runtime.NODEJS_12_X,
      code: lambda.Code.fromAsset('./resources/custom-resources/kibana-config'),
      handler: 'kibanaConfigurer.handler',
      timeout: cdk.Duration.seconds(100),
      memorySize: 3000,
      environment: {
        Region: cdk.Stack.of(this).region,
      },
    });
    const esFullAccessPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonESFullAccess');
        elasticsearchConfiurationLambda.role?.addManagedPolicy(esFullAccessPolicy);

        // construct event to be passed to AWS Lambda
        const esPropertyMap = {};
        Object.defineProperties(esPropertyMap,
          {
            ElasticsearchObject: {
              enumerable: true,
              value: elasticsearchDomain.elasticsearchClusterConfig,
            },
            ElasticsearchDomain: {
              enumerable: true,
              value: elasticsearchDomain.attrDomainEndpoint,
            },
          });

        const provider = new customResources.Provider(this, 'Elasticsearch Provider', {
          onEventHandler: elasticsearchConfiurationLambda,
        });
        const elasticsearchConfiguration = new cdk.CustomResource(this, 'ElasticsearchSetup', {
          serviceToken: provider.serviceToken,
          properties: esPropertyMap,
        });
        elasticsearchConfiguration.node.addDependency(elasticsearchDomain);
  }
}

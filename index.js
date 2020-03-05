const { getDomainAndSubdomain } = require('./helpers');

const aws = require('@pulumi/aws');
const pulumi = require('@pulumi/pulumi');

const TEN_MINUTES = 60 * 10;

class StaticFrontendWithLambdaBackend extends pulumi.ComponentResource {
    constructor(name, targetDomain, contentBucket, apiGateway, logsBucket = undefined) {
        super('StaticFrontendWithLambdaBackend', name, {}, {});

        if (!logsBucket) {
            logsBucket = this.createLogsBucket(name, targetDomain);
        }

        const certificateArn = this.provisionCertificate(name, targetDomain);

        // distributionArgs configures the CloudFront distribution. Relevant documentation:
        // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html
        // https://www.terraform.io/docs/providers/aws/r/cloudfront_distribution.html
        const cloudFrontDistribution = this.createCloudFrontDistribution(name,
            targetDomain, contentBucket, apiGateway, certificateArn, logsBucket);

        const aliasRecord = this.createAliasRecord(name, targetDomain, cloudFrontDistribution);

        this.registerOutputs({
            certificateArn,
            aliasRecord: this.aliasRecord,
            cloudFrontDistribution,
        });

        this.certificateArn = certificateArn;
        this.cloudFrontDistribution = cloudFrontDistribution;
        this.aliasRecord = aliasRecord;
    }

    createCloudFrontDistribution(name, targetDomain, contentBucket, apiGateway, certificateArn, logsBucket) {
        return new aws.cloudfront.Distribution(`${name}-cloudfront`, {
            enabled: true,
            aliases: [targetDomain],

            origins: [
                {
                    originId: contentBucket.arn,
                    domainName: contentBucket.websiteEndpoint,
                    customOriginConfig: {
                        originProtocolPolicy: 'http-only',
                        httpPort: 80,
                        httpsPort: 443,
                        originSslProtocols: ['TLSv1.2'],
                    },
                },
                {
                    domainName: apiGateway.url.apply(s => s.replace(/^https?:\/\/([^/]*).*/, '$1')),
                    originId: 'api',
                    originPath: '/stage',
                    customOriginConfig: {
                        originProtocolPolicy: 'https-only',
                        httpPort: 80,
                        httpsPort: 443,
                        originSslProtocols: ['TLSv1.2'],
                    }
                }
            ],

            defaultRootObject: 'index.html',

            defaultCacheBehavior: {
                targetOriginId: contentBucket.arn,

                viewerProtocolPolicy: 'redirect-to-https',
                allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                cachedMethods: ['GET', 'HEAD', 'OPTIONS'],

                forwardedValues: {
                    cookies: { forward: 'none' },
                    queryString: false,
                },

                minTtl: 0,
                defaultTtl: TEN_MINUTES,
                maxTtl: TEN_MINUTES,
            },

            orderedCacheBehaviors: [
                {
                    pathPattern: '/api/*',
                    allowedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
                    cachedMethods: ['HEAD', 'GET', 'OPTIONS'],
                    targetOriginId: 'api',

                    defaultTtl: 0,
                    minTtl: 0,
                    maxTtl: 0,

                    forwardedValues: {
                        queryString: true,
                        cookies: {
                            forward: 'all',
                        },
                    },
                    viewerProtocolPolicy: 'redirect-to-https',
                },
            ],

            priceClass: 'PriceClass_100',

            customErrorResponses: [
                {
                    errorCode: 404,
                    responseCode: 404,
                    responsePagePath: '/404.html',
                },
                {
                    errorCode: 403,
                    responseCode: 200,
                    responsePagePath: '/index.html',
                }
            ],

            restrictions: {
                geoRestriction: {
                    restrictionType: 'none',
                },
            },

            viewerCertificate: {
                acmCertificateArn: certificateArn,
                sslSupportMethod: 'sni-only',
            },

            loggingConfig: {
                bucket: logsBucket.bucketDomainName,
                includeCookies: false,
                prefix: `${targetDomain}/`,
            },
        }, { parent: this });
    }

    createLogsBucket(name, targetDomain) {
        return new aws.s3.Bucket(`${name}-front-logs`,
            {
                bucket: `${targetDomain}-logs`,
                acl: 'private',
            }, { parent: this });
    }

    provisionCertificate(name, targetDomain) {
        const eastRegion = new aws.Provider('east', {
            profile: aws.config.profile,
            region: 'us-east-1', // Per AWS, ACM certificate must be in the us-east-1 region.
        });

        const certificate = new aws.acm.Certificate(`${name}-certificate`, {
            domainName: targetDomain,
            validationMethod: 'DNS',
        }, { provider: eastRegion, parent: this });

        const domainParts = getDomainAndSubdomain(targetDomain);
        const hostedZoneId = aws.route53.getZone({ name: domainParts.parentDomain },
            { async: true })
            .then(zone => zone.zoneId);

        const certificateValidationDomain = new aws.route53.Record(`${name}-validation`, {
            name: certificate.domainValidationOptions[0].resourceRecordName,
            zoneId: hostedZoneId,
            type: certificate.domainValidationOptions[0].resourceRecordType,
            records: [certificate.domainValidationOptions[0].resourceRecordValue],
            ttl: TEN_MINUTES,
        }, { parent: this });

        const certificateValidation = new aws.acm.CertificateValidation(
            `${name}-certificateValidation`, {
                certificateArn: certificate.arn,
                validationRecordFqdns: [certificateValidationDomain.fqdn],
            }, { provider: eastRegion, parent: this });

        return certificateValidation.certificateArn;
    };

    createAliasRecord(name, targetDomain, distribution) {
        const domainParts = getDomainAndSubdomain(targetDomain);
        const hostedZoneId = aws.route53.getZone({ name: domainParts.parentDomain },
            { async: true })
            .then(zone => zone.zoneId);

        return new aws.route53.Record(
            name,
            {
                name: domainParts.subdomain,
                zoneId: hostedZoneId,
                type: 'A',
                aliases: [
                    {
                        name: distribution.domainName,
                        zoneId: distribution.hostedZoneId,
                        evaluateTargetHealth: true,
                    },
                ],
            }, { parent: this });
    }
}


module.exports = {
    StaticFrontendWithLambdaBackend,
};
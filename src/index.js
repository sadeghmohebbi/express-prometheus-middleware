const express = require('express');
const Prometheus = require('prom-client');
const ResponseTime = require('response-time');

const {
  requestCountGenerator,
  requestDurationGenerator,
  requestLengthGenerator,
  responseLengthGenerator,
} = require('./metrics');

const {
  normalizeStatusCode,
  normalizePath,
  isValidUrl
} = require('./normalizers');

const defaultOptions = {
  metricsPath: '/metrics',
  metricsApp: null,
  authenticate: null,
  collectDefaultMetrics: true,
  collectGCMetrics: false,
  // buckets for response time from 0.05s to 2.5s
  // these are arbitrary values since i dont know any better ¯\_(ツ)_/¯
  requestDurationBuckets: Prometheus.exponentialBuckets(0.05, 1.75, 8),
  requestLengthBuckets: [],
  responseLengthBuckets: [],
  extraMasks: [],
  customLabels: [],
  transformLabels: null,
  normalizeStatus: true,
  pushgatewayUrl: null,
  pushgatewayAuth: null, // { username: String, password: String }
  pushgatewayJobName: null,
  pushInterval: 60 * 1000,
  pushCallback: function (err, resp, body) {
    if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
      if (err) {
        console.error('Error pushing metrics to Pushgateway:', err);
      } else {
        console.log('Metrics pushed to Pushgateway:', body.toString(), 'with response: ', resp.toString());
      }
    }
  }
};

module.exports = (userOptions = {}) => {
  const options = { ...defaultOptions, ...userOptions };
  const originalLabels = ['route', 'method', 'status'];
  options.customLabels = new Set([...originalLabels, ...options.customLabels]);
  options.customLabels = [...options.customLabels];
  const { metricsPath, metricsApp, normalizeStatus } = options;

  const app = express();
  app.disable('x-powered-by');

  const requestDuration = requestDurationGenerator(
    options.customLabels,
    options.requestDurationBuckets,
    options.prefix,
  );
  const requestCount = requestCountGenerator(
    options.customLabels,
    options.prefix,
  );
  const requestLength = requestLengthGenerator(
    options.customLabels,
    options.requestLengthBuckets,
    options.prefix,
  );
  const responseLength = responseLengthGenerator(
    options.customLabels,
    options.responseLengthBuckets,
    options.prefix,
  );

  /**
   * Corresponds to the R(equest rate), E(error rate), and D(uration of requests),
   * of the RED metrics.
   */
  const redMiddleware = ResponseTime((req, res, time) => {
    const { originalUrl, method } = req;
    // will replace ids from the route with `#val` placeholder this serves to
    // measure the same routes, e.g., /image/id1, and /image/id2, will be
    // treated as the same route
    const route = normalizePath(originalUrl, options.extraMasks);

    if (route !== metricsPath) {
      const status = normalizeStatus
        ? normalizeStatusCode(res.statusCode) : res.statusCode.toString();

      const labels = { route, method, status };

      if (typeof options.transformLabels === 'function') {
        options.transformLabels(labels, req, res);
      }
      requestCount.inc(labels);

      // observe normalizing to seconds
      requestDuration.observe(labels, time / 1000);

      // observe request length
      if (options.requestLengthBuckets.length) {
        const reqLength = req.get('Content-Length');
        if (reqLength) {
          requestLength.observe(labels, Number(reqLength));
        }
      }

      // observe response length
      if (options.responseLengthBuckets.length) {
        const resLength = res.get('Content-Length');
        if (resLength) {
          responseLength.observe(labels, Number(resLength));
        }
      }
    }
  });

  if (options.collectDefaultMetrics) {
    // when this file is required, we will start to collect automatically
    // default metrics include common cpu and head usage metrics that can be
    // used to calculate saturation of the service
    Prometheus.collectDefaultMetrics({
      prefix: options.prefix,
    });
  }

  if (options.collectGCMetrics) {
    // if the option has been turned on, we start collecting garbage
    // collector metrics too. using try/catch because the dependency is
    // optional and it could not be installed
    try {
      /* eslint-disable global-require */
      /* eslint-disable import/no-extraneous-dependencies */
      const gcStats = require('prometheus-gc-stats');
      /* eslint-enable import/no-extraneous-dependencies */
      /* eslint-enable global-require */
      const startGcStats = gcStats(Prometheus.register, {
        prefix: options.prefix,
      });
      startGcStats();
    } catch (err) {
      // the dependency has not been installed, skipping
    }
  }

  app.use(redMiddleware);

  /**
   * Metrics route to be used by prometheus to scrape metrics
   */
  const routeApp = metricsApp || app;
  routeApp.get(metricsPath, async (req, res, next) => {
    if (typeof options.authenticate === 'function') {
      let result = null;
      try {
        result = await options.authenticate(req);
      } catch (err) {
        // treat errors as failures to authenticate
      }

      // the requester failed to authenticate, then return next, so we don't
      // hint at the existance of this route
      if (!result) {
        return next();
      }
    }

    res.set('Content-Type', Prometheus.register.contentType);
    return res.end(await Prometheus.register.metrics());
  });

  /**
   * Pushgateway implementation
   */
  if (options.pushgatewayUrl && options.pushgatewayJobName && isValidUrl(options.pushgatewayUrl)) {
    // so pushgateway is enabled
    try {
      let pushgatewayClientOptions = {
        timeout: 5000, //Set the request timeout to 5000ms
        agent: new http.Agent({
          keepAlive: true,
          keepAliveMsec: 10000,
          maxSockets: 5,
        }),
      }
      if (options.pushgatewayAuth && options.pushgatewayAuth.username && options.pushgatewayAuth.password) {
        pushgatewayClientOptions.auth = `${options.pushgatewayAuth.username}:${options.pushgatewayAuth.password}`
      }

      const pushgateway = new Prometheus.Pushgateway(options.pushgatewayUrl,  pushgatewayClientOptions)
  
      function pushMetricsToPrometheusPushgateway() {
        try {
          pushgateway.pushAdd({ jobName: options.pushgatewayJobName }, options.pushCallback)
        } catch(err) {
          console.error(err)
        }
      }
      
      setInterval(pushMetricsToPrometheusPushgateway, options.pushInterval)
    } catch (err) {
      console.error(err)
    }
  }

  return app;
};

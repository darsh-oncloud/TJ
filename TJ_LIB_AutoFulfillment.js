/**
 * @NApiVersion 2.1
 */
define(['N/runtime', 'N/https', 'N/record', 'N/search', 'N/log'],
function (runtime, https, record, search, log) {

    var SHOPIFY_ORDER_FIELD = 'custbody_shopify_order_id_2';
    var JAZZ_CREATED_FIELD = 'custbody_jazz_fulfillment_created';
    var SHOPIFY_SENT_FIELD = 'custbody_shopify_fulfillment_sent';
    var SKU_FIELD = 'custcol_sku_external_id';
    var SHOPIFY_LINE_FIELD = 'custcol_shopify_line_item_id';
    var SHOPIFY_API_VERSION = '2026-01';
    var JAZZ_CANCELLED_SKU_LINE_FIELD = 'custcol_jazz_cancelled_sku_note';
    var JAZZ_CANCELLED_QTY_LINE_FIELD = 'custcol_jazz_cancelled_qty';

    var jazzToken = null;
    var jazzTokenTime = 0;
    var shopifyToken = null;
    var shopifyTokenTime = 0;

    function processSalesOrder(soId, wmsOrderNumber) {
        var ifId = '';
        var shipment = null;

        try {
            log.audit('ORDER START', {
                soId: soId,
                wmsOrderNumber: wmsOrderNumber
            });

            shipment = getJazzShipment(wmsOrderNumber);

            if (!shipment) {
                log.audit('NO JAZZ SHIPMENT FOUND', {
                    soId: soId,
                    wmsOrderNumber: wmsOrderNumber
                });
                return;
            }

            var status = String(shipment.status || '').toLowerCase();

            if (status !== 'confirmed' && status !== 'shipped') {
                log.audit('JAZZ SHIPMENT NOT READY', {
                    soId: soId,
                    wmsOrderNumber: wmsOrderNumber,
                    jazzStatus: shipment.status
                });
                return;
            }

            ifId = createItemFulfillmentFromJazz(soId, shipment);

            log.audit('NETSUITE FULFILLMENT CREATED', {
                soId: soId,
                wmsOrderNumber: wmsOrderNumber,
                ifId: ifId
            });

            processShopifyFulfillment(ifId, soId, wmsOrderNumber);

        } catch (e) {
            var errMsg = getErr(e);

            log.error('ORDER PROCESS ERROR', {
                soId: soId,
                wmsOrderNumber: wmsOrderNumber,
                ifId: ifId,
                error: errMsg
            });

            if (
                errMsg.indexOf('No SKU matched between Jazz shipment and NetSuite IF lines') !== -1
            ) {
                updateSalesOrderWithJazzCancelledLines(soId, wmsOrderNumber);
            }
        }
    }

    function getJazzShipment(orderNumber) {
        var domain = getParam('custscript_jazz_domain_if', '');
        var tenant = getParam('custscript_jazz_tenant', 'TMJ');
        var path = getParam(
            'custscript_jazz_ship_lookup_path_if',
            '/api/v1/shipment/status?limit=10&order_number={order_number}'
        );

        var url = 'https://' + domain + path.replace('{order_number}', encodeURIComponent(orderNumber));

        var response = https.get({
            url: url,
            headers: {
                'Accept': 'application/json',
                'Tenant': tenant,
                'Authorization': 'Token ' + getJazzToken()
            }
        });

        log.audit('JAZZ GET RESPONSE', {
            orderNumber: orderNumber,
            code: response.code
        });

        if (response.code === 404) return null;

        if (Number(response.code) < 200 || Number(response.code) >= 300) {
            throw new Error('Jazz GET failed HTTP ' + response.code + ' :: ' + response.body);
        }

        return selectBestJazzShipment(JSON.parse(response.body || '{}'));
    }

    function getJazzToken() {
        var now = new Date().getTime();

        if (jazzToken && now - jazzTokenTime < 1200000) {
            return jazzToken;
        }

        var domain = getParam('custscript_jazz_domain_if', '');
        var username = getParam('custscript_jazz_username_if', '');
        var password = getParam('custscript_jazz_password_if', '');

        var response = https.post({
            url: 'https://' + domain + '/api/token/',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                username: username,
                password: password
            })
        });

        if (Number(response.code) < 200 || Number(response.code) >= 300) {
            throw new Error('Jazz token failed HTTP ' + response.code + ' :: ' + response.body);
        }

        var body = JSON.parse(response.body || '{}');

        jazzToken = body.token || body.key || body.access_token || body.auth_token;
        jazzTokenTime = now;

        if (!jazzToken) {
            throw new Error('Jazz token missing');
        }

        return jazzToken;
    }

    function selectBestJazzShipment(obj) {
        var arr = [];

        if (Array.isArray(obj)) arr = obj;
        else if (obj && Array.isArray(obj.results)) arr = obj.results;
        else if (obj && Array.isArray(obj.data)) arr = obj.data;
        else if (obj && Array.isArray(obj.shipments)) arr = obj.shipments;
        else if (obj && obj.result && Array.isArray(obj.result)) arr = obj.result;

        if (!arr.length) return null;

        var best = null;
        var bestScore = -1;

        for (var i = 0; i < arr.length; i++) {
            var sh = arr[i] || {};
            var st = String(sh.status || '').toLowerCase();
            var score = 0;

            if (st === 'confirmed' || st === 'shipped') score += 1000;
            if (sh.tracking_number) score += 50;
            if (sh.shipment_detail && sh.shipment_detail.length) score += 50;

            if (score > bestScore) {
                bestScore = score;
                best = sh;
            }
        }

        return best;
    }

    function createItemFulfillmentFromJazz(soId, shipment) {
        var shipMap = buildJazzShipMap(shipment);

        var ifRec = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: soId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: false
        });

        safeSet(ifRec, 'shipstatus', 'C');
        safeSet(ifRec, JAZZ_CREATED_FIELD, true);
        safeSet(ifRec, 'custbody_mtracking', shipment.tracking_number || shipment.carton_number || '');
        safeSet(ifRec, 'custbody_wms_order_number', shipment.order_number || '');
        safeSet(ifRec, 'custbody_total_weight', shipment.weight || '');
        safeSet(ifRec, 'custbody_no_cartons', '1');
        safeSet(ifRec, 'custbody_total_qty_shipped', String(getTotalJazzQty(shipment)));

        // Shopify order number field on IF
        // safeSet(ifRec, SHOPIFY_ORDER_FIELD, shipment.po_number || '');

        setShipDates(ifRec, shipment.ship_date);
        setShipMethodFromJazzCode(ifRec, shipment.ship_code);

        var lineCount = ifRec.getLineCount({ sublistId: 'item' });
        var matched = false;

        for (var i = 0; i < lineCount; i++) {
            var lineSku = getIfLineSku(ifRec, i);
            var shippedQty = shipMap[lineSku] || 0;

            if (shippedQty > 0) {
                matched = true;

                safeSetLine(ifRec, 'item', 'itemreceive', i, true);
                safeSetLine(ifRec, 'item', 'quantity', i, shippedQty);

                var shopifyLineId = findShopifyLineIdForSku(shipment, lineSku);

                if (shopifyLineId) {
                    safeSetLine(ifRec, 'item', SHOPIFY_LINE_FIELD, i, String(shopifyLineId));
                }

            } else {
                safeSetLine(ifRec, 'item', 'itemreceive', i, false);
            }
        }

        if (!matched) {
            throw new Error('No SKU matched between Jazz shipment and NetSuite IF lines');
        }

        addPackageLine(ifRec, shipment);

        return ifRec.save({
            enableSourcing: false,
            ignoreMandatoryFields: true
        });
    }

    function buildJazzShipMap(shipment) {
        var map = {};
        var details = shipment.shipment_detail || [];

        for (var i = 0; i < details.length; i++) {
            var sku = String(details[i].sku_code || '');
            var qty = Number(details[i].qty_shipped || 0);

            if (sku && qty > 0) {
                map[sku] = (map[sku] || 0) + qty;
            }
        }

        return map;
    }

    function getIfLineSku(ifRec, line) {
        var sku = '';

        try {
            sku = String(ifRec.getSublistValue({
                sublistId: 'item',
                fieldId: SKU_FIELD,
                line: line
            }) || '');
        } catch (e1) {}

        if (!sku) {
            try {
                sku = String(ifRec.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: line
                }) || '');
            } catch (e2) {}
        }

        return sku ? sku.split(':').join('_') : '';
    }

    function findShopifyLineIdForSku(shipment, lineSku) {
        var details = shipment.shipment_detail || [];

        for (var i = 0; i < details.length; i++) {
            var sku = String(details[i].sku_code || '');

            if (sku === lineSku) {
                var attr = details[i].detail_attributes || {};
                return attr.line_number || '';
            }
        }

        return '';
    }

    function setShipDates(ifRec, shipDate) {
        try {
            // TESTING ONLY: using today's date because Jazz ship date may be in closed period.
            // var d = new Date(shipDate + 'T00:00:00Z');

            var d = new Date();

            safeSet(ifRec, 'trandate', d);
            safeSet(ifRec, 'pickeddate', d);
            safeSet(ifRec, 'packeddate', d);
            safeSet(ifRec, 'shippeddate', d);

            log.audit('IF DATE SET FOR TESTING', {
                originalJazzShipDate: shipDate,
                dateUsed: d
            });

        } catch (e) {
            log.error('SHIP DATE SET FAILED', getErr(e));
        }
    }

    function setShipMethodFromJazzCode(ifRec, shipCode) {
        var data = getShipMethodInternalIdFromShipCode(shipCode);

        if (!data || !data.shipmethodId) return;

        safeSet(ifRec, 'shipmethod', data.shipmethodId);
        safeSet(ifRec, 'custbody_scac_routing_code', data.scac);
    }

    function getShipMethodInternalIdFromShipCode(shipCode) {
        var raw = getParam('custscript_ship_code_mapping_if', '');

        if (!raw) {
            return { shipmethodId: '', scac: '' };
        }

        try {
            var map = JSON.parse(raw);
            var entry = map ? map[String(shipCode)] : null;

            if (!entry) return { shipmethodId: '', scac: '' };

            if (Array.isArray(entry) && entry.length === 2 && !Array.isArray(entry[0])) {
                return {
                    shipmethodId: String(entry[0] || ''),
                    scac: String(entry[1] || '')
                };
            }

            if (Array.isArray(entry) && entry.length && Array.isArray(entry[0])) {
                for (var i = 0; i < entry.length; i++) {
                    var pair = entry[i];

                    if (Array.isArray(pair) && pair.length >= 2) {
                        return {
                            shipmethodId: String(pair[0] || ''),
                            scac: String(pair[1] || '')
                        };
                    }
                }
            }

            return { shipmethodId: '', scac: '' };

        } catch (e) {
            log.error('SHIP CODE MAPPING ERROR', getErr(e));
            return { shipmethodId: '', scac: '' };
        }
    }

    function addPackageLine(ifRec, shipment) {
        var tracking = shipment.tracking_number || shipment.carton_number || '';
        if (!tracking) return;

        try {
            var line = ifRec.getLineCount({ sublistId: 'package' });

            ifRec.insertLine({
                sublistId: 'package',
                line: line
            });

            safeSetLine(ifRec, 'package', 'packagedescr', line, tracking);
            safeSetLine(ifRec, 'package', 'packagetrackingnumber', line, tracking);

            if (shipment.weight) {
                safeSetLine(ifRec, 'package', 'packageweight', line, Number(shipment.weight || 0));
            }
        } catch (e) {}
    }

    function processShopifyFulfillment(ifId, soId, wmsOrderNumber) {
        try {
            var ifRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: ifId,
                isDynamic: false
            });

            var shopifyOrderId = ifRec.getValue({ fieldId: SHOPIFY_ORDER_FIELD }) || '';
            var alreadySent = ifRec.getValue({ fieldId: SHOPIFY_SENT_FIELD });

            if (!shopifyOrderId) {
                throw new Error('Shopify order id is blank on Item Fulfillment');
            }

            if (alreadySent === true || alreadySent === 'T') {
                return;
            }

            var groupedData = getIFGroupedData(ifId);

            if (!groupedData.lines.length) {
                throw new Error('No Shopify line item data found on Item Fulfillment');
            }

            var orderData = getShopifyOrderFulfillmentOrders(shopifyOrderId);
            var fulfillmentInput = buildFulfillmentInput(orderData, groupedData.lines);

            createShopifyFulfillment(
                fulfillmentInput,
                groupedData.trackingNumber,
                groupedData.shipMethod
            );

            markShopifySent(ifId);

            log.audit('SHOPIFY SUCCESS', {
                soId: soId,
                wmsOrderNumber: wmsOrderNumber,
                ifId: ifId,
                shopifyOrderId: shopifyOrderId
            });

        } catch (e) {
            var msg = simplifyShopifyError(getErr(e));

            log.error('SHOPIFY ERROR', {
                soId: soId,
                wmsOrderNumber: wmsOrderNumber,
                ifId: ifId,
                error: msg
            });

            if (msg === 'Order already fulfilled in Shopify') {
                markShopifySent(ifId);
            }
        }
    }

    function getIFGroupedData(ifId) {
        var resultObj = {
            shipMethod: 'Other',
            trackingNumber: '',
            lines: []
        };

        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['type', 'anyof', 'ItemShip'],
                'AND',
                ['internalid', 'anyof', String(ifId)],
                'AND',
                [SHOPIFY_SENT_FIELD, 'is', 'F'],
                'AND',
                [SHOPIFY_LINE_FIELD, 'isnotempty', ''],
                'AND',
                [SHOPIFY_ORDER_FIELD, 'isnotempty', ''],
                'AND',
                ['status', 'anyof', 'ItemShip:C']
            ],
            columns: [
                search.createColumn({ name: SHOPIFY_LINE_FIELD, summary: search.Summary.GROUP }),
                search.createColumn({ name: 'quantity', summary: search.Summary.MAX }),
                search.createColumn({ name: 'shipmethod', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'trackingnumbers', summary: search.Summary.GROUP })
            ]
        }).run().each(function (result) {
            var lineId = result.getValue({
                name: SHOPIFY_LINE_FIELD,
                summary: search.Summary.GROUP
            });

            var qty = Number(result.getValue({
                name: 'quantity',
                summary: search.Summary.MAX
            }) || 0);

            var tracking = result.getValue({
                name: 'trackingnumbers',
                summary: search.Summary.GROUP
            }) || '';

            var shipMethod = '';

            try {
                shipMethod = result.getText({
                    name: 'shipmethod',
                    summary: search.Summary.GROUP
                }) || '';
            } catch (e1) {}

            if (!shipMethod) {
                shipMethod = result.getValue({
                    name: 'shipmethod',
                    summary: search.Summary.GROUP
                }) || 'Other';
            }

            if (lineId && qty > 0) {
                resultObj.lines.push({
                    shopifyLineItemId: String(lineId),
                    quantity: qty
                });
            }

            if (shipMethod && resultObj.shipMethod === 'Other') {
                resultObj.shipMethod = shipMethod;
            }

            if (tracking && !resultObj.trackingNumber) {
                resultObj.trackingNumber = tracking;
            }

            return true;
        });

        return resultObj;
    }

    function getShopifyOrderFulfillmentOrders(shopifyOrderId) {
        var query = [
            'query getOrderFulfillmentOrders($id: ID!) {',
            '  order(id: $id) {',
            '    id',
            '    name',
            '    fulfillmentOrders(first: 20) {',
            '      edges {',
            '        node {',
            '          id',
            '          status',
            '          lineItems(first: 100) {',
            '            edges {',
            '              node {',
            '                id',
            '                remainingQuantity',
            '                lineItem { id }',
            '              }',
            '            }',
            '          }',
            '        }',
            '      }',
            '    }',
            '  }',
            '}'
        ].join('\n');

        var response = shopifyGraphQL(query, {
            id: 'gid://shopify/Order/' + shopifyOrderId
        });

        if (response.errors && response.errors.length) {
            throw new Error('Shopify query errors :: ' + JSON.stringify(response.errors));
        }

        if (!response.data || !response.data.order) {
            throw new Error('Shopify order not found');
        }

        return response.data.order;
    }

    function buildFulfillmentInput(orderData, groupedLines) {
        var foEdges = (((orderData || {}).fulfillmentOrders || {}).edges || []);
        var mapByOrderLineId = {};
        var groupedByFO = {};
        var output = [];
        var hasAnyLineMatch = false;
        var hasAnyFulfillableQty = false;

        for (var i = 0; i < foEdges.length; i++) {
            var foNode = foEdges[i].node;
            var liEdges = (((foNode || {}).lineItems || {}).edges || []);

            for (var j = 0; j < liEdges.length; j++) {
                var liNode = liEdges[j].node;
                var orderLineId = '';

                if (liNode && liNode.lineItem && liNode.lineItem.id) {
                    orderLineId = String(liNode.lineItem.id).replace('gid://shopify/LineItem/', '');
                }

                if (orderLineId) {
                    mapByOrderLineId[orderLineId] = {
                        fulfillmentOrderId: foNode.id,
                        fulfillmentOrderStatus: foNode.status || '',
                        fulfillmentOrderLineItemId: liNode.id,
                        remainingQuantity: Number(liNode.remainingQuantity || 0)
                    };
                }
            }
        }

        for (var x = 0; x < groupedLines.length; x++) {
            var current = groupedLines[x];
            var match = mapByOrderLineId[String(current.shopifyLineItemId)];

            if (!match) continue;

            hasAnyLineMatch = true;

            var qtyToSend = Number(current.quantity || 0);

            if (qtyToSend > match.remainingQuantity) {
                qtyToSend = match.remainingQuantity;
            }

            if (qtyToSend <= 0) continue;

            hasAnyFulfillableQty = true;

            if (!groupedByFO[match.fulfillmentOrderId]) {
                groupedByFO[match.fulfillmentOrderId] = {
                    fulfillmentOrderId: match.fulfillmentOrderId,
                    fulfillmentOrderLineItems: []
                };
            }

            groupedByFO[match.fulfillmentOrderId].fulfillmentOrderLineItems.push({
                id: match.fulfillmentOrderLineItemId,
                quantity: qtyToSend
            });
        }

        for (var key in groupedByFO) {
            if (groupedByFO.hasOwnProperty(key)) {
                output.push(groupedByFO[key]);
            }
        }

        if (!output.length) {
            if (hasAnyLineMatch && !hasAnyFulfillableQty) {
                throw new Error('Order already fulfilled in Shopify');
            }

            throw new Error('No Shopify fulfillment order line match found');
        }

        return output;
    }

    function createShopifyFulfillment(lineItemsByFulfillmentOrder, trackingNumber, shipMethod) {
        var mutation = [
            'mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {',
            '  fulfillmentCreate(fulfillment: $fulfillment) {',
            '    fulfillment { id status }',
            '    userErrors { field message }',
            '  }',
            '}'
        ].join('\n');

        var input = {
            lineItemsByFulfillmentOrder: lineItemsByFulfillmentOrder,
            notifyCustomer: true
        };

        if (trackingNumber) {
            input.trackingInfo = {
                number: trackingNumber,
                company: shipMethod || 'Other'
            };
        }

        var response = shopifyGraphQL(mutation, {
            fulfillment: input
        });

        if (response.errors && response.errors.length) {
            throw new Error('Shopify mutation errors :: ' + JSON.stringify(response.errors));
        }

        if (
            response.data &&
            response.data.fulfillmentCreate &&
            response.data.fulfillmentCreate.userErrors &&
            response.data.fulfillmentCreate.userErrors.length
        ) {
            throw new Error('Shopify userErrors :: ' + JSON.stringify(response.data.fulfillmentCreate.userErrors));
        }

        return response;
    }

    function shopifyGraphQL(query, variables) {
        var store = getParam('custscript_shopify_store', '');

        var response = https.post({
            url: 'https://' + store + '/admin/api/' + SHOPIFY_API_VERSION + '/graphql.json',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': getShopifyAccessToken()
            },
            body: JSON.stringify({
                query: query,
                variables: variables || {}
            })
        });

        if (Number(response.code) < 200 || Number(response.code) >= 300) {
            throw new Error('Shopify GraphQL HTTP Error ' + response.code + ' :: ' + response.body);
        }

        return JSON.parse(response.body || '{}');
    }

    function getShopifyAccessToken() {
        var now = new Date().getTime();

        if (shopifyToken && now - shopifyTokenTime < 1200000) {
            return shopifyToken;
        }

        var store = getParam('custscript_shopify_store', '');
        var clientId = getParam('custscript_shopify_client_id', '');
        var clientSecret = getParam('custscript_shopify_client_secret', '');

        var response = https.post({
            url: 'https://' + store + '/admin/oauth/access_token',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret
            })
        });

        if (Number(response.code) < 200 || Number(response.code) >= 300) {
            throw new Error('Shopify Token HTTP Error ' + response.code + ' :: ' + response.body);
        }

        var body = JSON.parse(response.body || '{}');

        shopifyToken = body.access_token;
        shopifyTokenTime = now;

        if (!shopifyToken) {
            throw new Error('No Shopify access token returned');
        }

        return shopifyToken;
    }

    function markShopifySent(ifId) {
        record.submitFields({
            type: record.Type.ITEM_FULFILLMENT,
            id: ifId,
            values: makeObj(SHOPIFY_SENT_FIELD, true),
            options: {
                enableSourcing: false,
                ignoreMandatoryFields: true
            }
        });
    }

    /**
     * UPDATED FUNCTION
     * Old logic updated body field.
     * New logic loads SO, finds matching item line, and sets cancel note + cancel qty on line fields.
     */
    function updateSalesOrderWithJazzCancelledLines(soId, wmsOrderNumber) {
        try {
            var cancels = getJazzCancelTransactions(wmsOrderNumber);

            if (!cancels || !cancels.length) {
                log.audit('NO JAZZ CANCELLED LINES FOUND', {
                    soId: soId,
                    wmsOrderNumber: wmsOrderNumber
                });
                return;
            }

            var cancelMap = buildJazzCancelMap(cancels);

            if (!cancelMap || !hasObjectValue(cancelMap)) {
                log.audit('NO VALID JAZZ CANCEL QTY FOUND', {
                    soId: soId,
                    wmsOrderNumber: wmsOrderNumber
                });
                return;
            }

            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var lineCount = soRec.getLineCount({
                sublistId: 'item'
            });

            var updatedCount = 0;
            var unmatchedSkus = [];

            for (var jazzSku in cancelMap) {
                if (!cancelMap.hasOwnProperty(jazzSku)) {
                    continue;
                }

                var nsSku = convertJazzSkuToNetSuiteItemName(jazzSku);
                var cancelQty = Number(cancelMap[jazzSku] || 0);
                var matchedLine = -1;

                for (var i = 0; i < lineCount; i++) {
                    var soLineSku = getSalesOrderLineSku(soRec, i);
                    var committedQty = getSalesOrderLineCommittedQty(soRec, i);

                    if (
                        normalizeSku(soLineSku) === normalizeSku(nsSku) &&
                        committedQty > 0
                    ) {
                        matchedLine = i;
                        break;
                    }
                }

                if (matchedLine >= 0) {
                    safeSetLine(
                        soRec,
                        'item',
                        JAZZ_CANCELLED_SKU_LINE_FIELD,
                        matchedLine,
                        'Cancle SKU: ' + jazzSku
                    );

                    safeSetLine(
                        soRec,
                        'item',
                        JAZZ_CANCELLED_QTY_LINE_FIELD,
                        matchedLine,
                        cancelQty
                    );

                    updatedCount++;

                    log.audit('JAZZ CANCEL LINE UPDATED ON SO LINE', {
                        soId: soId,
                        wmsOrderNumber: wmsOrderNumber,
                        jazzSku: jazzSku,
                        netSuiteSku: nsSku,
                        cancelQty: cancelQty,
                        line: matchedLine
                    });

                } else {
                    unmatchedSkus.push({
                        jazzSku: jazzSku,
                        netSuiteSku: nsSku,
                        cancelQty: cancelQty
                    });
                }
            }

            if (updatedCount > 0) {
                soRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });
            }

            if (unmatchedSkus.length) {
                log.error('JAZZ CANCEL SKU NOT MATCHED ON SO LINE', {
                    soId: soId,
                    wmsOrderNumber: wmsOrderNumber,
                    unmatchedSkus: unmatchedSkus
                });
            }

            log.audit('JAZZ CANCELLED LINES UPDATE COMPLETE', {
                soId: soId,
                wmsOrderNumber: wmsOrderNumber,
                updatedCount: updatedCount
            });

        } catch (e) {
            log.error('UPDATE SO CANCELLED JAZZ LINES ERROR', {
                soId: soId,
                wmsOrderNumber: wmsOrderNumber,
                error: getErr(e)
            });
        }
    }

    function buildJazzCancelMap(cancels) {
        var map = {};

        for (var i = 0; i < cancels.length; i++) {
            var cancelLine = cancels[i] || {};

            var sku = String(cancelLine.sku_code || '');
            var qty = Number(cancelLine.quantity || 0);

            if (sku && qty > 0) {
                map[sku] = Number(map[sku] || 0) + qty;
            }
        }

        return map;
    }

    function convertJazzSkuToNetSuiteItemName(jazzSku) {
        return String(jazzSku || '').split('_').join(':');
    }

    function getSalesOrderLineSku(soRec, line) {
        var sku = '';

        try {
            sku = String(soRec.getSublistValue({
                sublistId: 'item',
                fieldId: SKU_FIELD,
                line: line
            }) || '');
        } catch (e1) {}

        if (!sku) {
            try {
                sku = String(soRec.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: line
                }) || '');
            } catch (e2) {}
        }

        return sku;
    }

    function getSalesOrderLineCommittedQty(soRec, line) {
        var qty = 0;

        try {
            qty = Number(soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'quantitycommitted',
                line: line
            }) || 0);
        } catch (e) {
            qty = 0;
        }

        return qty;
    }

    function normalizeSku(value) {
        return String(value || '')
            .split('_').join(':')
            .replace(/\s+/g, '')
            .toUpperCase();
    }

    function hasObjectValue(obj) {
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                return true;
            }
        }

        return false;
    }

    function getJazzCancelTransactions(orderNumber) {
        var domain = getParam('custscript_jazz_domain_if', '');
        var tenant = getParam('custscript_jazz_tenant', 'TMJ');

        var results = [];
        var url = 'https://' + domain + '/api/v1/order/cancels?limit=250&order_number=' +
            encodeURIComponent(orderNumber);

        var pageCount = 0;

        while (url && pageCount < 10) {
            pageCount++;

            var response = https.get({
                url: url,
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Tenant': tenant,
                    'Authorization': 'Token ' + getJazzToken()
                }
            });

            log.audit('JAZZ CANCEL GET RESPONSE', {
                orderNumber: orderNumber,
                code: response.code,
                page: pageCount
            });

            if (response.code === 404) {
                return results;
            }

            if (Number(response.code) < 200 || Number(response.code) >= 300) {
                throw new Error('Jazz Cancel GET failed HTTP ' + response.code + ' :: ' + response.body);
            }

            var body = JSON.parse(response.body || '{}');
            var arr = [];

            if (body && Array.isArray(body.results)) {
                arr = body.results;
            } else if (Array.isArray(body)) {
                arr = body;
            }

            for (var i = 0; i < arr.length; i++) {
                results.push(arr[i]);
            }

            url = body.next || '';
        }

        return results;
    }

    function getTotalJazzQty(shipment) {
        var details = shipment.shipment_detail || [];
        var total = 0;

        for (var i = 0; i < details.length; i++) {
            total += Number(details[i].qty_shipped || 0);
        }

        return total;
    }

    function getSearchValue(result, key) {
        var values = result.values || {};
        var v = values[key];

        if (v === null || v === undefined) return '';

        if (Array.isArray(v)) {
            if (!v.length) return '';
            return v[0].value || v[0].text || '';
        }

        if (typeof v === 'object') {
            return v.value || v.text || '';
        }

        return String(v || '');
    }

    function safeSet(rec, fieldId, value) {
        if (value === null || value === undefined || value === '') return;

        try {
            rec.setValue({
                fieldId: fieldId,
                value: value
            });
        } catch (e) {}
    }

    function safeSetLine(rec, sublistId, fieldId, line, value) {
        if (value === null || value === undefined || value === '') return;

        try {
            rec.setSublistValue({
                sublistId: sublistId,
                fieldId: fieldId,
                line: line,
                value: value
            });
        } catch (e) {}
    }

    function getParam(id, defVal) {
        var val = runtime.getCurrentScript().getParameter({ name: id });
        return val === null || val === undefined || val === '' ? defVal : val;
    }

    function makeObj(fieldId, value) {
        var obj = {};
        obj[fieldId] = value;
        return obj;
    }

    function getErr(e) {
        return e && e.message ? e.message : String(e || 'Unknown error');
    }

    function simplifyShopifyError(msg) {
        var text = String(msg || '').replace(/[\r\n\t]+/g, ' ');
        var lower = text.toLowerCase();

        if (
            lower.indexOf('already fulfilled') !== -1 ||
            lower.indexOf('remaining quantity') !== -1 ||
            lower.indexOf('does not need fulfillment') !== -1
        ) {
            return 'Order already fulfilled in Shopify';
        }

        return text.length > 300 ? text.substring(0, 300) : text;
    }

    return {
        processSalesOrder: processSalesOrder,
        getSearchValue: getSearchValue
    };
});
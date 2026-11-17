<?php
/**
 * Plugin Name: BiteSites Lead Count
 * Description: Read-only, secret-protected REST endpoint that tells BiteSites how many operational leads the site received in a date range, for monthly "Lead Generation" invoicing. Returns counts only — never names, emails or phone numbers.
 * Version: 1.1.0
 * Requires at least: 6.0
 * Requires PHP: 8.0
 * Author: BiteSites
 * License: GPL-2.0-or-later
 *
 * Endpoint
 *   GET /wp-json/bitesites/v1/lead-count?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   Header: X-BiteSites-Secret: <BITESITES_LEADS_SECRET>
 *
 *   `start` is inclusive and `end` is exclusive, both midnight in the BILLING
 *   timezone (America/New_York unless BITESITES_LEADS_BILLING_TZ is defined).
 *   Those instants are converted to the site's timezone (Settings → General),
 *   the clock `created_at` is written in (`current_time('mysql')`), before
 *   querying — so a month means the business's calendar month even when the
 *   site clock is UTC.
 *
 * Configuration (wp-config.php, above "That's all, stop editing!"):
 *   define('BITESITES_LEADS_SECRET', '<same value as the BiteSites WP_LEADS_SECRET>');
 *
 * What counts as a lead
 *   Rows of the first-party lead table (`{prefix}caah_leads`, the table Team View
 *   reads) created in the range, after the two rules Team View applies:
 *     1. Test/evaluation rows are excluded: an email containing ".invalid", or a
 *        name containing "test" or "eval".
 *     2. Repeat submissions are collapsed: rows sharing a normalized name, email
 *        or phone number (transitively) count once. Collapsing is done within the
 *        requested range only, so a person who also enquired in an earlier month
 *        counts again in the new month.
 *   The response reports how many rows each rule removed, so the invoice can be
 *   checked against Team View.
 */

if (!defined('ABSPATH')) {
    exit;
}

const BITESITES_LEAD_COUNT_MAX_DAYS = 93;
const BITESITES_LEAD_COUNT_RULE = 'team_view_operational_v1';

add_action('rest_api_init', static function () {
    register_rest_route('bitesites/v1', '/lead-count', [
        'methods' => 'GET',
        'callback' => 'bitesites_lead_count_response',
        'permission_callback' => 'bitesites_lead_count_permission',
        'args' => [
            'start' => ['required' => true, 'type' => 'string', 'validate_callback' => 'bitesites_lead_count_valid_date'],
            'end' => ['required' => true, 'type' => 'string', 'validate_callback' => 'bitesites_lead_count_valid_date'],
        ],
    ]);
});

function bitesites_lead_count_valid_date($value)
{
    if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
        return false;
    }
    [$year, $month, $day] = array_map('intval', explode('-', $value));
    return checkdate($month, $day, $year);
}

/**
 * Constant-time check of the shared secret. Fails closed: no constant, a short
 * constant, a missing header or plain HTTP (outside local development) all deny.
 */
function bitesites_lead_count_permission(WP_REST_Request $request)
{
    $expected = defined('BITESITES_LEADS_SECRET') ? (string) BITESITES_LEADS_SECRET : '';
    if (strlen($expected) < 24) {
        return new WP_Error('bitesites_not_configured', 'BITESITES_LEADS_SECRET is missing or shorter than 24 characters on this site.', ['status' => 503]);
    }
    $allow_http = defined('BITESITES_LEADS_ALLOW_HTTP') && BITESITES_LEADS_ALLOW_HTTP;
    if (!is_ssl() && !$allow_http) {
        return new WP_Error('bitesites_https_required', 'Request must use HTTPS.', ['status' => 403]);
    }
    $provided = (string) $request->get_header('x_bitesites_secret');
    if ($provided === '') {
        return new WP_Error('bitesites_secret_missing', 'X-BiteSites-Secret header is missing.', ['status' => 401]);
    }
    if (!hash_equals($expected, $provided)) {
        return new WP_Error('bitesites_secret_mismatch', 'X-BiteSites-Secret does not match this site\'s BITESITES_LEADS_SECRET.', ['status' => 401]);
    }
    return true;
}

function bitesites_lead_count_table()
{
    global $wpdb;
    return function_exists('caah_leads_table') ? caah_leads_table() : $wpdb->prefix . 'caah_leads';
}

function bitesites_lead_count_is_test($row)
{
    $email = strtolower(trim((string) $row->email));
    $name = strtolower(trim((string) $row->first_name . ' ' . (string) $row->last_name));
    return str_contains($email, '.invalid') || str_contains($name, 'eval') || str_contains($name, 'test');
}

/** The same identity keys Team View deduplicates on. */
function bitesites_lead_count_identity_keys($row)
{
    $keys = [];
    $name = strtolower(trim((string) $row->first_name . ' ' . (string) $row->last_name));
    if (function_exists('remove_accents')) {
        $name = remove_accents($name);
    }
    $name = trim((string) preg_replace('/[^a-z0-9]+/', ' ', $name));
    if (strlen($name) >= 2) {
        $keys[] = 'name:' . $name;
    }
    $email = strtolower((string) preg_replace('/\s+/', '', trim((string) $row->email)));
    if (is_email($email)) {
        $keys[] = 'email:' . $email;
    }
    $phone = (string) preg_replace('/\D+/', '', (string) $row->phone);
    if (strlen($phone) > 10 && '1' === substr($phone, 0, 1)) {
        $phone = substr($phone, -10);
    }
    if (strlen($phone) >= 7) {
        $keys[] = 'phone:' . $phone;
    }
    return array_values(array_unique($keys));
}

/** Number of distinct people after transitive matching on name, email or phone. */
function bitesites_lead_count_distinct($rows)
{
    $parent = [];
    $find = static function ($node) use (&$parent, &$find) {
        while ($parent[$node] !== $node) {
            $parent[$node] = $parent[$parent[$node]];
            $node = $parent[$node];
        }
        return $node;
    };
    $owner = [];
    foreach (array_values($rows) as $index => $row) {
        $parent[$index] = $index;
        foreach (bitesites_lead_count_identity_keys($row) as $key) {
            if (isset($owner[$key])) {
                $parent[$find($index)] = $find($owner[$key]);
            } else {
                $owner[$key] = $index;
            }
        }
    }
    $roots = [];
    foreach (array_keys($parent) as $index) {
        $roots[$find($index)] = true;
    }
    return count($roots);
}

/**
 * Apply Team View's rules and return [operational row count, distinct lead count].
 *
 * On CAAH, Team View's rules live in the portal-pet-manager plugin
 * (ppm_operational_lead_rows: drops test/evaluation rows; ppm_deduplicate_lead_rows:
 * collapses repeat submissions). Calling those exact functions means the billed count
 * cannot drift from what staff see in Team View. The embedded copies above are used
 * only on a site that does not have that plugin.
 */
function bitesites_lead_count_apply_rules($rows)
{
    if (function_exists('ppm_operational_lead_rows') && function_exists('ppm_deduplicate_lead_rows')) {
        [$operational] = ppm_operational_lead_rows($rows);
        [$visible] = ppm_deduplicate_lead_rows($operational);
        return [count($operational), count($visible)];
    }
    $operational = array_values(array_filter($rows, static fn($row) => !bitesites_lead_count_is_test($row)));
    return [count($operational), bitesites_lead_count_distinct($operational)];
}

function bitesites_lead_count_response(WP_REST_Request $request)
{
    global $wpdb;

    $start = (string) $request->get_param('start');
    $end = (string) $request->get_param('end');
    $billing_tz = new DateTimeZone(defined('BITESITES_LEADS_BILLING_TZ') ? (string) BITESITES_LEADS_BILLING_TZ : 'America/New_York');
    $site_tz = wp_timezone();
    // Midnight in the billing timezone, expressed on the site clock used by created_at.
    $start_at = (new DateTimeImmutable($start . ' 00:00:00', $billing_tz))->setTimezone($site_tz);
    $end_at = (new DateTimeImmutable($end . ' 00:00:00', $billing_tz))->setTimezone($site_tz);
    if ($end_at <= $start_at) {
        return new WP_Error('bitesites_bad_range', 'end must be after start.', ['status' => 400]);
    }
    if ($start_at->diff($end_at)->days > BITESITES_LEAD_COUNT_MAX_DAYS) {
        return new WP_Error('bitesites_bad_range', 'The range may span at most ' . BITESITES_LEAD_COUNT_MAX_DAYS . ' days.', ['status' => 400]);
    }

    $table = bitesites_lead_count_table();
    $exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) === $table;
    if (!$exists) {
        return new WP_Error('bitesites_no_lead_table', 'The lead table does not exist on this site.', ['status' => 503]);
    }

    // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is internal.
    $rows = $wpdb->get_results($wpdb->prepare(
        "SELECT id, created_at, first_name, last_name, email, phone FROM {$table} WHERE created_at >= %s AND created_at < %s",
        $start_at->format('Y-m-d H:i:s'),
        $end_at->format('Y-m-d H:i:s')
    ));
    // A failed query leaves an empty result, which must not be billed as zero leads.
    if (!is_array($rows) || '' !== (string) $wpdb->last_error) {
        return new WP_Error('bitesites_query_failed', 'Could not read the lead table.', ['status' => 500]);
    }

    [$operational_count, $count] = bitesites_lead_count_apply_rules($rows);

    $response = new WP_REST_Response([
        'count' => $count,
        'total_rows' => count($rows),
        'excluded_test' => count($rows) - $operational_count,
        'duplicates' => $operational_count - $count,
        'start' => $start,
        'end' => $end,
        'end_exclusive' => true,
        'timezone' => $billing_tz->getName(),
        'site_timezone' => wp_timezone_string(),
        'query_from' => $start_at->format('Y-m-d H:i:s'),
        'query_to' => $end_at->format('Y-m-d H:i:s'),
        'rule' => BITESITES_LEAD_COUNT_RULE,
    ], 200);
    $response->header('Cache-Control', 'no-store, private');
    return $response;
}

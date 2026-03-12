<?php

if (!defined('ABSPATH')) {
    exit;
}

class Baseline_Admin
{
    private const DEFAULT_API_BASE = 'https://baseline-api.simonrankine4.workers.dev';
    private const LEGACY_API_BASE = 'https://launchguard-api.simonrankine4.workers.dev';
    private const OPTION_API_BASE = 'baseline_api_base_url';
    private const OPTION_SITE_TOKEN = 'baseline_site_token';
    private const OPTION_SITE_ID = 'baseline_site_id';
    private const OPTION_TENANT_ID = 'baseline_tenant_id';
    private const OPTION_LAST_SCAN_ID = 'baseline_last_scan_id';
    private const OPTION_DEFAULT_FORM_MODE = 'baseline_default_form_mode';
    private const OPTION_SCAN_DEFAULTS = 'baseline_scan_defaults';

    private const META_SCAN_OPTIONS = '_baseline_scan_options';
    private const META_SCAN_USE_SITE_DEFAULTS = '_baseline_scan_use_site_defaults';
    private const META_LAST_SCAN_ID = '_baseline_last_scan_id';

    public function __construct()
    {
        add_action('admin_menu', [$this, 'register_menu']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_assets']);

        add_action('admin_post_baseline_register_site', [$this, 'handle_register_site']);
        add_action('admin_post_baseline_run_scan', [$this, 'handle_run_scan']);
        add_action('admin_post_baseline_run_page_scan', [$this, 'handle_run_page_scan']);
        add_action('admin_post_baseline_cancel_scan', [$this, 'handle_cancel_scan']);
        add_action('admin_post_baseline_save_branding', [$this, 'handle_save_branding']);
        add_action('admin_post_baseline_start_checkout', [$this, 'handle_start_checkout']);
        add_action('wp_ajax_baseline_poll_scan', [$this, 'handle_poll_scan']);
        add_action('wp_ajax_baseline_cancel_scan', [$this, 'handle_cancel_scan_ajax']);
        add_action('admin_bar_menu', [$this, 'render_active_scan_toolbar_chip'], 100);

        add_action('add_meta_boxes', [$this, 'register_scan_metaboxes']);
        add_action('save_post', [$this, 'handle_save_scan_metabox'], 10, 2);

        add_action('admin_notices', [$this, 'render_admin_notice']);
    }

    public function register_menu(): void
    {
        add_menu_page(
            __('Baseline', 'baseline'),
            __('Baseline', 'baseline'),
            'manage_options',
            'baseline-dashboard',
            [$this, 'render_dashboard'],
            'dashicons-shield-alt',
            65
        );

        add_submenu_page(
            'baseline-dashboard',
            __('Scan', 'baseline'),
            __('Scan', 'baseline'),
            'manage_options',
            'baseline-scan',
            [$this, 'render_scan']
        );

        add_submenu_page(
            'baseline-dashboard',
            __('Branding', 'baseline'),
            __('Branding', 'baseline'),
            'manage_options',
            'baseline-branding',
            [$this, 'render_branding']
        );

        add_submenu_page(
            'baseline-dashboard',
            __('Billing', 'baseline'),
            __('Billing', 'baseline'),
            'manage_options',
            'baseline-billing',
            [$this, 'render_billing']
        );

        add_submenu_page(
            'baseline-dashboard',
            __('Settings', 'baseline'),
            __('Settings', 'baseline'),
            'manage_options',
            'baseline-settings',
            [$this, 'render_settings']
        );

        global $submenu;
        if (isset($submenu['baseline-dashboard'][0][0])) {
            $submenu['baseline-dashboard'][0][0] = __('Dashboard', 'baseline');
        }
    }

    public function register_settings(): void
    {
        register_setting('baseline_settings_group', self::OPTION_API_BASE, [
            'type' => 'string',
            'sanitize_callback' => [$this, 'sanitize_api_base_setting'],
            'default' => self::DEFAULT_API_BASE
        ]);

        register_setting('baseline_settings_group', self::OPTION_SITE_TOKEN, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('baseline_settings_group', self::OPTION_SITE_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('baseline_settings_group', self::OPTION_TENANT_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('baseline_settings_group', self::OPTION_LAST_SCAN_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('baseline_settings_group', self::OPTION_DEFAULT_FORM_MODE, [
            'type' => 'string',
            'sanitize_callback' => [$this, 'sanitize_form_mode'],
            'default' => 'dry-run'
        ]);

        register_setting('baseline_settings_group', self::OPTION_SCAN_DEFAULTS, [
            'type' => 'array',
            'sanitize_callback' => [$this, 'sanitize_scan_defaults_option'],
            'default' => $this->default_scan_options()
        ]);
    }

    public function sanitize_form_mode(string $value): string
    {
        return in_array($value, ['dry-run', 'live'], true) ? $value : 'dry-run';
    }

    public function sanitize_api_base_setting($value): string
    {
        // SEC-012: Validate the API base URL beyond esc_url_raw.
        // Require HTTPS, block private hosts, and enforce an explicit allowlist
        // to prevent redirecting plugin traffic to arbitrary endpoints.
        $sanitized = untrailingslashit(esc_url_raw((string) $value));
        if ($sanitized === '') {
            return self::DEFAULT_API_BASE;
        }
        if (strcasecmp($sanitized, self::LEGACY_API_BASE) === 0) {
            return self::DEFAULT_API_BASE;
        }

        $parsed = wp_parse_url($sanitized);
        $scheme = strtolower((string) ($parsed['scheme'] ?? ''));
        $host   = strtolower((string) ($parsed['host'] ?? ''));

        // Must be HTTPS.
        if ($scheme !== 'https') {
            add_settings_error(
                self::OPTION_API_BASE,
                'baseline_api_base_scheme',
                __('API Base URL must use HTTPS.', 'baseline')
            );
            return self::DEFAULT_API_BASE;
        }

        // Block loopback addresses and unqualified hostnames.
        $blocked_patterns = [
            '/^localhost$/i',
            '/^127\.\d+\.\d+\.\d+$/',
            '/^10\.\d+\.\d+\.\d+$/',
            '/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/',
            '/^192\.168\.\d+\.\d+$/',
            '/^::1$/',
        ];
        foreach ($blocked_patterns as $pattern) {
            if (preg_match($pattern, $host)) {
                add_settings_error(
                    self::OPTION_API_BASE,
                    'baseline_api_base_host',
                    __('API Base URL must not point to a local or private address.', 'baseline')
                );
                return self::DEFAULT_API_BASE;
            }
        }

        $defaultHost = strtolower((string) wp_parse_url(self::DEFAULT_API_BASE, PHP_URL_HOST));
        $legacyHost = strtolower((string) wp_parse_url(self::LEGACY_API_BASE, PHP_URL_HOST));
        $allowedHosts = [$defaultHost, $legacyHost];

        if (defined('BASELINE_ALLOWED_API_HOSTS') && is_string(BASELINE_ALLOWED_API_HOSTS) && BASELINE_ALLOWED_API_HOSTS !== '') {
            $extraHosts = array_map('trim', explode(',', BASELINE_ALLOWED_API_HOSTS));
            foreach ($extraHosts as $extraHost) {
                $normalizedHost = strtolower($extraHost);
                if ($normalizedHost !== '') {
                    $allowedHosts[] = $normalizedHost;
                }
            }
        }

        $allowedHosts = apply_filters('baseline_allowed_api_hosts', $allowedHosts, $sanitized);
        $allowedHosts = array_values(array_unique(array_filter(array_map('strtolower', (array) $allowedHosts))));
        if ($host === '' || !in_array($host, $allowedHosts, true)) {
            add_settings_error(
                self::OPTION_API_BASE,
                'baseline_api_base_not_allowed',
                __('API Base URL host is not in the allowed list.', 'baseline')
            );
            return self::DEFAULT_API_BASE;
        }

        return $sanitized;
    }

    public function sanitize_scan_defaults_option($value): array
    {
        return $this->sanitize_scan_options($value, $this->default_scan_options());
    }

    public function enqueue_assets(string $hook): void
    {
        $needsAssets = strpos($hook, 'baseline') !== false || in_array($hook, ['post.php', 'post-new.php'], true);
        if (!$needsAssets) {
            return;
        }
        $cssPath = BASELINE_PLUGIN_DIR . 'assets/css/admin.css';
        $cssVersion = file_exists($cssPath) ? (string) filemtime($cssPath) : BASELINE_VERSION;
        wp_enqueue_style('baseline-admin', BASELINE_PLUGIN_URL . 'assets/css/admin.css', [], $cssVersion);
    }

    public function register_scan_metaboxes(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }

        foreach ($this->get_supported_scan_post_types() as $postType) {
            add_meta_box(
                'baseline-page-scan',
                __('Baseline Page Scan', 'baseline'),
                [$this, 'render_page_scan_metabox'],
                $postType,
                'side',
                'high'
            );
        }
    }

    public function render_page_scan_metabox(WP_Post $post): void
    {
        if (!current_user_can('manage_options')) {
            echo '<p>You need administrator access to run scans.</p>';
            return;
        }

        $defaults = $this->get_scan_defaults();
        $storedOptions = $this->get_post_scan_options($post->ID, $defaults);
        $useSiteDefaults = $this->get_post_scan_use_defaults($post->ID);
        $effectiveOptions = $useSiteDefaults ? $defaults : $storedOptions;
        $formMode = $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run');
        $targetUrl = $this->get_published_target_url($post->ID);
        $isPublished = $targetUrl !== '';
        $submitModeInputId = 'baseline_scan_submit_mode_' . (int) $post->ID;

        wp_nonce_field('baseline_page_scan_settings', 'baseline_page_scan_settings_nonce');
        wp_nonce_field('baseline_run_page_scan', 'baseline_run_page_scan_nonce');

        echo '<input type="hidden" name="baseline_post_id" value="' . esc_attr((string) $post->ID) . '" />';
        echo '<input type="hidden" id="' . esc_attr($submitModeInputId) . '" name="baseline_scan_submit_mode" value="custom" />';

        echo '<p><strong>Target URL</strong><br />';
        echo '<input class="widefat" type="text" readonly value="' . esc_attr($targetUrl !== '' ? $targetUrl : 'Publish this content to generate a public URL.') . '" /></p>';

        echo '<p><strong>Form Mode</strong><br />';
        echo '<select class="widefat" name="baseline_page_form_mode">';
        echo '<option value="dry-run"' . selected($formMode, 'dry-run', false) . '>dry-run</option>';
        echo '<option value="live"' . selected($formMode, 'live', false) . '>live</option>';
        echo '</select></p>';

        echo '<div class="baseline-metabox-options">';
        echo '<input type="hidden" name="baseline_scan_use_site_defaults" value="0" />';
        echo '<label class="baseline-toggle-row">';
        echo '<input type="checkbox" name="baseline_scan_use_site_defaults" value="1" ' . checked($useSiteDefaults, true, false) . ' />';
        echo '<span><strong>Use Site Defaults</strong></span>';
        echo '</label>';
        echo '<p class="description">Use your global scan profile from Baseline Dashboard.</p>';

        $this->render_scan_option_rows($effectiveOptions, 'baseline_scan_options');
        echo '</div>';

        $actionUrl = esc_url(admin_url('admin-post.php'));
        $disabled = $isPublished ? '' : ' disabled="disabled"';

        echo '<p class="baseline-metabox-actions">';
        echo '<button type="submit" class="button button-primary" formmethod="post" formaction="' . $actionUrl . '" name="action" value="baseline_run_page_scan" onclick="document.getElementById(\'' . esc_attr($submitModeInputId) . '\').value=\'custom\';"' . $disabled . '>Scan This Page</button> ';
        echo '<button type="submit" class="button" formmethod="post" formaction="' . $actionUrl . '" name="action" value="baseline_run_page_scan" onclick="document.getElementById(\'' . esc_attr($submitModeInputId) . '\').value=\'defaults\';"' . $disabled . '>Use Site Defaults</button>';
        echo '</p>';

        if (!$isPublished) {
            echo '<p class="description">Publish this page to generate a public URL before scanning.</p>';
        }

        $this->render_metabox_last_scan($post->ID);
        $this->render_scan_form_script();
    }

    public function handle_save_scan_metabox(int $postId, WP_Post $post): void
    {
        if (!is_admin() || !current_user_can('manage_options')) {
            return;
        }

        if (wp_is_post_revision($postId) || wp_is_post_autosave($postId)) {
            return;
        }

        if (!isset($_POST['baseline_page_scan_settings_nonce'])) {
            return;
        }

        $nonce = sanitize_text_field((string) wp_unslash($_POST['baseline_page_scan_settings_nonce']));
        if (!wp_verify_nonce($nonce, 'baseline_page_scan_settings')) {
            return;
        }

        if (!current_user_can('edit_post', $postId)) {
            return;
        }

        if (!in_array($post->post_type, $this->get_supported_scan_post_types(), true)) {
            return;
        }

        $defaults = $this->get_scan_defaults();
        $rawOptions = wp_unslash($_POST['baseline_scan_options'] ?? []);
        $scanOptions = $this->sanitize_scan_options($rawOptions, $defaults);
        $useSiteDefaults = !empty($_POST['baseline_scan_use_site_defaults']);

        update_post_meta($postId, self::META_SCAN_OPTIONS, $scanOptions);
        update_post_meta($postId, self::META_SCAN_USE_SITE_DEFAULTS, $useSiteDefaults ? '1' : '0');
    }

    public function render_admin_notice(): void
    {
        if (!is_admin()) {
            return;
        }

        if (!isset($_GET['baseline_notice']) || !isset($_GET['baseline_message'])) {
            $this->render_active_scan_notice();
            return;
        }

        $noticeType = sanitize_key((string) wp_unslash($_GET['baseline_notice']));
        $message = sanitize_text_field((string) wp_unslash($_GET['baseline_message']));
        $class = $noticeType === 'success' ? 'notice notice-success' : 'notice notice-error';

        echo '<div class="' . esc_attr($class) . ' is-dismissible"><p>' . esc_html($message);

        if (!empty($_GET['baseline_scan_id'])) {
            $scanId = sanitize_text_field((string) wp_unslash($_GET['baseline_scan_id']));
            $scanUrl = add_query_arg(['page' => 'baseline-scan'], admin_url('admin.php'));
            echo ' <a href="' . esc_url($scanUrl) . '">View latest scan</a> (' . esc_html($scanId) . ')';
        }

        echo '</p></div>';

        $this->render_active_scan_notice();
    }

    public function render_active_scan_toolbar_chip(WP_Admin_Bar $adminBar): void
    {
        if (!is_admin() || !current_user_can('manage_options')) {
            return;
        }

        $lastScan = $this->fetch_last_scan();
        if (is_wp_error($lastScan) || empty($lastScan) || !is_array($lastScan['data']['scan'] ?? null)) {
            return;
        }

        $scan = $lastScan['data']['scan'];
        $status = sanitize_key((string) ($scan['status'] ?? ''));
        if (!$this->is_scan_in_progress($status)) {
            return;
        }

        $summary = $this->extract_scan_summary($scan);
        $progress = $this->estimate_scan_progress($status, $summary);
        $scanId = sanitize_text_field((string) ($scan['id'] ?? ''));
        $href = add_query_arg(
            [
                'page' => 'baseline-scan',
                'baseline_scan_id' => $scanId,
                'baseline_open_modal' => '1'
            ],
            admin_url('admin.php')
        );

        $adminBar->add_node([
            'id' => 'baseline-active-scan',
            'title' => sprintf('Baseline Scan %d%%', $progress),
            'href' => esc_url($href),
            'meta' => [
                'title' => 'Open Baseline scan tracker'
            ]
        ]);
    }

    private function render_active_scan_notice(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }

        if (isset($_GET['page']) && sanitize_key((string) wp_unslash($_GET['page'])) === 'baseline-scan') {
            return;
        }

        $lastScan = $this->fetch_last_scan();
        if (is_wp_error($lastScan) || empty($lastScan) || !is_array($lastScan['data']['scan'] ?? null)) {
            return;
        }

        $scan = $lastScan['data']['scan'];
        $status = sanitize_key((string) ($scan['status'] ?? ''));
        if (!$this->is_scan_in_progress($status)) {
            return;
        }

        $summary = $this->extract_scan_summary($scan);
        $scanId = sanitize_text_field((string) ($scan['id'] ?? ''));
        $progress = $this->estimate_scan_progress($status, $summary);
        $currentUrl = $this->extract_current_scan_url($summary, $scan, $status);
        $scanUrl = add_query_arg(
            [
                'page' => 'baseline-scan',
                'baseline_scan_id' => $scanId,
                'baseline_open_modal' => '1'
            ],
            admin_url('admin.php')
        );

        echo '<div class="notice notice-info is-dismissible baseline-active-scan-notice"><p>';
        echo '<strong>Baseline active scan:</strong> ' . esc_html($progress) . '% complete.';
        if ($currentUrl !== '') {
            echo ' <code>' . esc_html($currentUrl) . '</code>';
        }
        echo ' <a href="' . esc_url($scanUrl) . '">Open Live Tracker</a>';
        echo '</p></div>';
    }

    public function render_dashboard(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);
        $connected = $siteId !== '';
        $siteHost = wp_parse_url(home_url('/'), PHP_URL_HOST);

        echo '<div class="wrap baseline-wrap baseline-dashboard">';
        echo '<div class="baseline-page-header">';
        echo '<div class="baseline-page-title">';
        echo '<h1>Baseline</h1>';
        echo '<p class="baseline-page-subtitle">Cloud QA control center for scans, evidence, and client-ready reporting.</p>';
        echo '</div>';
        echo '<div class="baseline-page-meta">';
        echo '<span class="baseline-badge ' . ($connected ? 'is-success' : 'is-warning') . '">' . ($connected ? 'Connected' : 'Not Connected') . '</span>';
        if (!empty($siteHost)) {
            echo '<span class="baseline-badge">' . esc_html((string) $siteHost) . '</span>';
        }
        echo '</div>';
        echo '</div>';

        if (!$connected) {
            echo '<div class="baseline-card baseline-card-hero">';
            echo '<h2>Connect This Site</h2>';
            echo '<p>Register this WordPress site with your Baseline API to enable checks and white-label controls.</p>';
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="baseline_register_site" />';
            wp_nonce_field('baseline_register_site');
            submit_button('Register Site');
            echo '</form>';
            echo '</div>';
            echo '</div>';
            return;
        }

        $limits = $this->fetch_limits($siteId);
        $scans = $this->fetch_scans($siteId, 10);

        echo '<div class="baseline-dashboard-grid">';
        echo '<div class="baseline-grid baseline-grid-top">';

        echo '<div class="baseline-card baseline-card-connection">';
        echo '<h2>Connection</h2>';
        echo '<ul class="baseline-kv-list">';
        echo '<li><span>Site ID</span><code>' . esc_html($siteId) . '</code></li>';
        echo '<li><span>Tenant ID</span><code>' . esc_html($this->get_option(self::OPTION_TENANT_ID)) . '</code></li>';
        echo '<li><span>API Base</span><code>' . esc_html($this->get_api_base()) . '</code></li>';
        echo '</ul>';
        echo '<div class="baseline-actions"><a class="button button-primary" href="' . esc_url(admin_url('admin.php?page=baseline-scan')) . '">Open Scan Workspace</a></div>';
        echo '</div>';

        echo '</div>';

        echo '<div class="baseline-grid baseline-grid-mid">';
        echo '<div class="baseline-card baseline-card-plan">';
        echo '<h2>Plan Usage</h2>';
        if (is_wp_error($limits)) {
            echo '<p>' . esc_html($limits->get_error_message()) . '</p>';
        } else {
            $data = $limits['data'];
            $planId = sanitize_text_field((string) ($data['plan_id'] ?? 'starter'));
            $billingStatus = sanitize_text_field((string) ($data['billing_status'] ?? 'trial'));
            $scansUsed = (int) ($data['scans_used'] ?? 0);
            $scansLimit = (int) ($data['scans_limit'] ?? 0);
            $usagePercent = $scansLimit > 0 ? (int) max(0, min(100, round(($scansUsed / $scansLimit) * 100))) : 0;

            echo '<ul class="baseline-kv-list">';
            echo '<li><span>Period</span><strong>' . esc_html((string) ($data['period_key'] ?? 'n/a')) . '</strong></li>';
            echo '<li><span>Plan</span><strong>' . esc_html($planId) . ' <span class="baseline-inline-muted">(' . esc_html($billingStatus) . ')</span></strong></li>';
            echo '<li><span>Scans</span><strong>' . esc_html((string) $scansUsed) . ' / ' . esc_html((string) $scansLimit) . '</strong></li>';
            echo '<li><span>Sites Limit</span><strong>' . esc_html((string) ($data['sites_limit'] ?? 0)) . '</strong></li>';
            echo '<li><span>Client PDF</span><strong>' . (!empty($data['pdf_export']) ? 'Included' : 'Not included') . '</strong></li>';
            echo '<li><span>Evidence ZIP</span><strong>' . (!empty($data['zip_export']) ? 'Included' : 'Not included') . '</strong></li>';
            echo '<li><span>White-label</span><strong>' . (!empty($data['whitelabel']) ? 'Included' : 'Not included') . '</strong></li>';
            echo '</ul>';
            echo '<div class="baseline-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' . esc_attr((string) $usagePercent) . '">';
            echo '<span style="width:' . esc_attr((string) $usagePercent) . '%"></span>';
            echo '</div>';
            echo '<div class="baseline-actions"><a class="button" href="' . esc_url(admin_url('admin.php?page=baseline-billing')) . '">Manage Billing</a></div>';
        }
        echo '</div>';

        echo '</div>';

        $this->render_recent_scans_card($scans);
        echo '</div>';
        echo '</div>';
    }

    public function render_scan(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);
        $connected = $siteId !== '';
        $siteHost = wp_parse_url(home_url('/'), PHP_URL_HOST);

        echo '<div class="wrap baseline-wrap baseline-scan-page">';
        echo '<div class="baseline-page-header">';
        echo '<div class="baseline-page-title">';
        echo '<h1>Scan</h1>';
        echo '<p class="baseline-page-subtitle">Configure and run site scans with live tracking.</p>';
        echo '</div>';
        echo '<div class="baseline-page-meta">';
        echo '<span class="baseline-badge ' . ($connected ? 'is-success' : 'is-warning') . '">' . ($connected ? 'Connected' : 'Not Connected') . '</span>';
        if (!empty($siteHost)) {
            echo '<span class="baseline-badge">' . esc_html((string) $siteHost) . '</span>';
        }
        echo '</div>';
        echo '</div>';

        if (!$connected) {
            echo '<div class="baseline-card baseline-card-hero">';
            echo '<h2>Connect This Site</h2>';
            echo '<p>Register this WordPress site with your Baseline API to enable checks and white-label controls.</p>';
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="baseline_register_site" />';
            wp_nonce_field('baseline_register_site');
            submit_button('Register Site');
            echo '</form>';
            echo '</div>';
            echo '</div>';
            return;
        }

        $scanDefaults = $this->get_scan_defaults();
        $scans = $this->fetch_scans($siteId, 10);
        $lastScan = $this->fetch_last_scan();
        $latestScanRow = [];
        if (!is_wp_error($lastScan) && is_array($lastScan['data']['scan'] ?? null)) {
            $latestScanRow = $lastScan['data']['scan'];
        }
        $latestScanId = sanitize_text_field((string) ($latestScanRow['id'] ?? ''));
        $noticeStatus = sanitize_key((string) wp_unslash($_GET['baseline_notice'] ?? ''));
        $modalScanId = sanitize_text_field((string) wp_unslash($_GET['baseline_scan_id'] ?? ''));
        if ($modalScanId === '' && $latestScanId !== '') {
            $modalScanId = $latestScanId;
        }
        $latestStatus = sanitize_key((string) ($latestScanRow['status'] ?? ''));
        $forceOpenModal = !empty($_GET['baseline_open_modal']) && sanitize_key((string) wp_unslash($_GET['baseline_open_modal'])) === '1';
        $shouldAutoOpenModal = $modalScanId !== '' && ($forceOpenModal || $noticeStatus === 'success' || $this->is_scan_in_progress($latestStatus));
        $lastCompletedReportUrl = $this->find_last_completed_report_url($scans);

        echo '<div class="baseline-scan-stack">';
        $this->render_scan_setup_card($scanDefaults);
        $this->render_latest_scan_card($lastScan, $latestScanRow, $lastCompletedReportUrl);
        echo '</div>';

        $this->render_recent_scans_card($scans);
        $this->render_scan_progress_modal($modalScanId, $shouldAutoOpenModal, $lastCompletedReportUrl);
        $this->render_scan_form_script();
        echo '</div>';
    }

    public function render_branding(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);

        echo '<div class="wrap baseline-wrap">';
        echo '<h1>Branding</h1>';

        if ($siteId === '') {
            echo '<p>Connect your site in Baseline Dashboard first.</p>';
            echo '</div>';
            return;
        }

        $limits = $this->fetch_limits($siteId);
        $planFeatures = $this->extract_plan_features($limits);
        $whitelabelEnabled = !empty($planFeatures['whitelabel']);

        $brandingData = [
            'brand_name' => '',
            'logo_url' => '',
            'primary_color' => '#1f2937',
            'accent_color' => '#22c55e',
            'footer_text' => '',
            'hide_baseline_branding' => 0
        ];

        $response = $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/branding');
        if (!is_wp_error($response) && isset($response['data']['branding']) && is_array($response['data']['branding'])) {
            $brandingData = array_merge($brandingData, $response['data']['branding']);
        }

        if (!$whitelabelEnabled) {
            echo '<div class="notice notice-warning"><p>White-label branding is available on the Agency plan. Upgrade to unlock PDF/client branding controls.</p></div>';
        }

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="baseline_save_branding" />';
        wp_nonce_field('baseline_save_branding');

        echo '<table class="form-table" role="presentation">';
        $disabledAttr = $whitelabelEnabled ? '' : ' disabled="disabled"';
        echo '<tr><th scope="row"><label for="baseline_brand_name">Brand Name</label></th><td><input class="regular-text" type="text" id="baseline_brand_name" name="brand_name" value="' . esc_attr((string) $brandingData['brand_name']) . '"' . $disabledAttr . ' /></td></tr>';
        echo '<tr><th scope="row"><label for="baseline_logo_url">Logo URL</label></th><td><input class="regular-text" type="url" id="baseline_logo_url" name="logo_url" value="' . esc_attr((string) $brandingData['logo_url']) . '"' . $disabledAttr . ' /></td></tr>';
        echo '<tr><th scope="row"><label for="baseline_primary_color">Primary Color</label></th><td><input type="color" id="baseline_primary_color" name="primary_color" value="' . esc_attr((string) $brandingData['primary_color']) . '"' . $disabledAttr . ' /></td></tr>';
        echo '<tr><th scope="row"><label for="baseline_accent_color">Accent Color</label></th><td><input type="color" id="baseline_accent_color" name="accent_color" value="' . esc_attr((string) $brandingData['accent_color']) . '"' . $disabledAttr . ' /></td></tr>';
        echo '<tr><th scope="row"><label for="baseline_footer_text">Footer Text</label></th><td><textarea class="large-text" rows="3" id="baseline_footer_text" name="footer_text"' . $disabledAttr . '>' . esc_textarea((string) $brandingData['footer_text']) . '</textarea></td></tr>';

        $checked = !empty($brandingData['hide_baseline_branding']) ? 'checked' : '';
        echo '<tr><th scope="row">White-label Mode</th><td><label><input type="checkbox" name="hide_baseline_branding" value="1" ' . esc_attr($checked) . $disabledAttr . ' /> Hide Baseline branding in exported reports</label></td></tr>';
        echo '</table>';

        if ($whitelabelEnabled) {
            submit_button('Save Branding');
        }
        echo '</form>';
        echo '</div>';
    }

    public function render_settings(): void
    {
        ?>
        <div class="wrap baseline-wrap">
            <h1>Settings</h1>
            <form method="post" action="options.php">
                <?php settings_fields('baseline_settings_group'); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="baseline_api_base_url">API Base URL</label></th>
                        <td><input class="regular-text" type="url" id="baseline_api_base_url" name="baseline_api_base_url" value="<?php echo esc_attr($this->get_option(self::OPTION_API_BASE, self::DEFAULT_API_BASE)); ?>" placeholder="https://baseline-api.your-subdomain.workers.dev" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="baseline_site_token">Site Token</label></th>
                        <td><input class="regular-text" type="text" id="baseline_site_token" name="baseline_site_token" value="<?php echo esc_attr($this->get_option(self::OPTION_SITE_TOKEN)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="baseline_site_id">Site ID</label></th>
                        <td><input class="regular-text" type="text" id="baseline_site_id" name="baseline_site_id" value="<?php echo esc_attr($this->get_option(self::OPTION_SITE_ID)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="baseline_tenant_id">Tenant ID</label></th>
                        <td><input class="regular-text" type="text" id="baseline_tenant_id" name="baseline_tenant_id" value="<?php echo esc_attr($this->get_option(self::OPTION_TENANT_ID)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="baseline_default_form_mode">Default Form Mode</label></th>
                        <td>
                            <select id="baseline_default_form_mode" name="baseline_default_form_mode">
                                <?php $mode = $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run'); ?>
                                <option value="dry-run" <?php selected($mode, 'dry-run'); ?>>dry-run</option>
                                <option value="live" <?php selected($mode, 'live'); ?>>live</option>
                            </select>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Settings'); ?>
            </form>
        </div>
        <?php
    }

    public function render_billing(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);

        echo '<div class="wrap baseline-wrap">';
        echo '<h1>Billing</h1>';

        if ($siteId === '') {
            echo '<p>Connect your site in Baseline Dashboard first.</p>';
            echo '</div>';
            return;
        }

        $response = $this->fetch_billing($siteId);
        if (is_wp_error($response)) {
            echo '<p>' . esc_html($response->get_error_message()) . '</p>';
            echo '</div>';
            return;
        }

        $data = is_array($response['data'] ?? null) ? $response['data'] : [];
        $billing = is_array($data['billing'] ?? null) ? $data['billing'] : [];
        $plans = is_array($data['plans'] ?? null) ? $data['plans'] : [];

        $currentPlanId = sanitize_text_field((string) ($billing['plan_id'] ?? 'starter'));
        $billingStatus = sanitize_text_field((string) ($billing['billing_status'] ?? 'trial'));
        $currentPeriodEnd = sanitize_text_field((string) ($billing['current_period_end'] ?? ''));
        $currentPlan = is_array($data['current_plan'] ?? null) ? $data['current_plan'] : [];

        echo '<div class="baseline-card">';
        echo '<h2>Current Subscription</h2>';
        echo '<p><strong>Plan:</strong> ' . esc_html($currentPlanId) . '</p>';
        echo '<p><strong>Status:</strong> ' . esc_html($billingStatus) . '</p>';
        if ($currentPeriodEnd !== '') {
            echo '<p><strong>Current Period End:</strong> ' . esc_html($currentPeriodEnd) . '</p>';
        }
        echo '<p><strong>Client PDF:</strong> ' . (!empty($currentPlan['pdf_export']) ? 'Included' : 'Not included') . '</p>';
        echo '<p><strong>Evidence ZIP:</strong> ' . (!empty($currentPlan['zip_export']) ? 'Included' : 'Not included') . '</p>';
        echo '<p><strong>White-label:</strong> ' . (!empty($currentPlan['whitelabel']) ? 'Included' : 'Not included') . '</p>';
        echo '</div>';

        if (empty($plans)) {
            echo '<div class="baseline-card"><p>No plans available yet.</p></div>';
            echo '</div>';
            return;
        }

        echo '<div class="baseline-plan-grid">';
        foreach ($plans as $plan) {
            $planId = sanitize_text_field((string) ($plan['id'] ?? ''));
            $planScans = (int) ($plan['scans_limit'] ?? 0);
            $planSites = (int) ($plan['sites_limit'] ?? 0);
            $planWhitelabel = !empty($plan['whitelabel']);
            $planPdf = !empty($plan['pdf_export']);
            $planZip = !empty($plan['zip_export']);
            $stripeConfigured = !empty($plan['stripe_price_configured']);
            $isCurrent = $planId === $currentPlanId;

            echo '<div class="baseline-card baseline-plan-card">';
            echo '<h2>' . esc_html(ucfirst($planId)) . '</h2>';
            if ($isCurrent) {
                echo '<p><span class="baseline-pill">Current</span></p>';
            }
            echo '<p><strong>Scans / month:</strong> ' . esc_html((string) $planScans) . '</p>';
            echo '<p><strong>Sites:</strong> ' . esc_html((string) $planSites) . '</p>';
            echo '<p><strong>Client PDF:</strong> ' . esc_html($planPdf ? 'Included' : 'No') . '</p>';
            echo '<p><strong>Evidence ZIP:</strong> ' . esc_html($planZip ? 'Included' : 'No') . '</p>';
            echo '<p><strong>White-label:</strong> ' . esc_html($planWhitelabel ? 'Included' : 'No') . '</p>';

            if (!$stripeConfigured) {
                echo '<p>Checkout not configured for this plan yet.</p>';
            }

            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="baseline_start_checkout" />';
            echo '<input type="hidden" name="plan_id" value="' . esc_attr($planId) . '" />';
            wp_nonce_field('baseline_start_checkout');

            $buttonText = $isCurrent ? 'Change Plan' : 'Choose Plan';
            $buttonDisabled = $stripeConfigured ? '' : ' disabled="disabled"';
            echo '<p><button class="button button-primary" type="submit"' . $buttonDisabled . '>' . esc_html($buttonText) . '</button></p>';
            echo '</form>';
            echo '</div>';
        }
        echo '</div>';

        echo '</div>';
    }

    public function handle_register_site(): void
    {
        $this->ensure_admin_post('baseline_register_site');
        $lockKey = $this->registration_lock_key();
        if (get_transient($lockKey)) {
            $this->redirect_with_notice('baseline-dashboard', 'error', 'Site registration is already in progress. Please wait a few seconds and retry.');
        }
        set_transient($lockKey, '1', 30);

        $payload = [
            'site_url' => home_url('/'),
            'tenant_id' => 'tenant-' . substr(md5(home_url('/')), 0, 12),
            'tenant_name' => get_bloginfo('name'),
            'plan_id' => 'starter',
            'wp_version' => get_bloginfo('version'),
            'php_version' => PHP_VERSION,
            'plugin_version' => BASELINE_VERSION,
            'timezone' => wp_timezone_string() ?: 'UTC'
        ];

        $response = $this->api_request('POST', '/v1/sites/register', $payload, false);
        if (is_wp_error($response)) {
            delete_transient($lockKey);
            $this->redirect_with_notice('baseline-dashboard', 'error', $response->get_error_message());
        }

        $data = $response['data'];
        if (empty($data['site_id']) || empty($data['site_token'])) {
            delete_transient($lockKey);
            $this->redirect_with_notice('baseline-dashboard', 'error', 'Site registration response missing required fields.');
        }

        update_option(self::OPTION_SITE_ID, sanitize_text_field((string) $data['site_id']));
        update_option(self::OPTION_SITE_TOKEN, sanitize_text_field((string) $data['site_token']));
        update_option(self::OPTION_TENANT_ID, sanitize_text_field((string) ($data['tenant_id'] ?? '')));

        delete_transient($lockKey);
        $this->redirect_with_notice('baseline-dashboard', 'success', 'Site registered successfully.');
    }

    public function handle_run_scan(): void
    {
        $this->ensure_admin_post('baseline_run_scan');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('baseline-scan', 'error', 'Connect the site before running scans.');
        }

        $formMode = $this->sanitize_form_mode(sanitize_text_field((string) wp_unslash($_POST['form_mode'] ?? 'dry-run')));
        $sitemapUrl = esc_url_raw((string) wp_unslash($_POST['sitemap_url'] ?? ''));
        $scanOptions = $this->sanitize_scan_options(wp_unslash($_POST['scan_options'] ?? []), $this->get_scan_defaults());

        update_option(self::OPTION_DEFAULT_FORM_MODE, $formMode);
        update_option(self::OPTION_SCAN_DEFAULTS, $scanOptions);

        $payload = [
            'site_id' => $siteId,
            'profile' => 'full_qa_no_visual',
            'form_mode' => $formMode,
            'trigger' => 'manual',
            'scan_options' => $scanOptions,
            'source_context' => [
                'source' => 'dashboard'
            ]
        ];
        if ($sitemapUrl !== '') {
            $payload['sitemap_url'] = $sitemapUrl;
        }

        $response = $this->api_request('POST', '/v1/scans', $payload);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('baseline-scan', 'error', $this->format_scan_api_error($response->get_error_message()));
        }

        $scanId = sanitize_text_field((string) ($response['data']['scan_id'] ?? ''));
        if ($scanId !== '') {
            update_option(self::OPTION_LAST_SCAN_ID, $scanId);
        }

        $this->redirect_with_notice('baseline-scan', 'success', 'Scan queued successfully.', $scanId);
    }

    public function handle_run_page_scan(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized request');
        }

        check_admin_referer('baseline_run_page_scan', 'baseline_run_page_scan_nonce');

        $postId = absint(wp_unslash($_POST['baseline_post_id'] ?? ($_POST['post_ID'] ?? 0)));
        if ($postId <= 0) {
            $this->redirect_with_notice('baseline-dashboard', 'error', 'Invalid post target for page scan.');
        }

        $post = get_post($postId);
        if (!$post instanceof WP_Post) {
            $this->redirect_with_notice('baseline-dashboard', 'error', 'Unable to load post for page scan.');
        }

        if (!in_array($post->post_type, $this->get_supported_scan_post_types(), true)) {
            $this->redirect_to_post_with_notice($postId, 'error', 'This post type is not eligible for Baseline page scans.');
        }

        $targetUrl = $this->get_published_target_url($postId);
        if ($targetUrl === '') {
            $this->redirect_to_post_with_notice($postId, 'error', 'Publish this page to generate a public URL before scanning.');
        }

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_to_post_with_notice($postId, 'error', 'Connect the site before running scans.');
        }

        $formMode = $this->sanitize_form_mode(sanitize_text_field((string) wp_unslash($_POST['baseline_page_form_mode'] ?? $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run'))));
        update_option(self::OPTION_DEFAULT_FORM_MODE, $formMode);

        $defaults = $this->get_scan_defaults();
        $storedPostOptions = $this->sanitize_scan_options(wp_unslash($_POST['baseline_scan_options'] ?? []), $defaults);
        $submitMode = sanitize_key((string) wp_unslash($_POST['baseline_scan_submit_mode'] ?? 'custom'));
        $useSiteDefaults = $submitMode === 'defaults' || !empty($_POST['baseline_scan_use_site_defaults']);
        $effectiveOptions = $useSiteDefaults ? $defaults : $storedPostOptions;

        update_post_meta($postId, self::META_SCAN_OPTIONS, $storedPostOptions);
        update_post_meta($postId, self::META_SCAN_USE_SITE_DEFAULTS, $useSiteDefaults ? '1' : '0');

        $payload = [
            'site_id' => $siteId,
            'profile' => 'full_qa_no_visual',
            'form_mode' => $formMode,
            'trigger' => 'manual',
            'target_url' => $targetUrl,
            'scan_options' => $effectiveOptions,
            'source_context' => [
                'source' => 'metabox',
                'post_id' => $postId,
                'post_type' => sanitize_key($post->post_type)
            ]
        ];

        $response = $this->api_request('POST', '/v1/scans', $payload);
        if (is_wp_error($response)) {
            $this->redirect_to_post_with_notice($postId, 'error', $this->format_scan_api_error($response->get_error_message()));
        }

        $scanId = sanitize_text_field((string) ($response['data']['scan_id'] ?? ''));
        if ($scanId !== '') {
            update_option(self::OPTION_LAST_SCAN_ID, $scanId);
            update_post_meta($postId, self::META_LAST_SCAN_ID, $scanId);
        }

        $this->redirect_to_post_with_notice($postId, 'success', 'Page scan queued successfully.', $scanId);
    }

    public function handle_save_branding(): void
    {
        $this->ensure_admin_post('baseline_save_branding');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('baseline-branding', 'error', 'Connect the site before saving branding.');
        }

        $limits = $this->fetch_limits($siteId);
        $planFeatures = $this->extract_plan_features($limits);
        if (empty($planFeatures['whitelabel'])) {
            $this->redirect_with_notice('baseline-branding', 'error', 'Upgrade to the Agency plan to unlock white-label branding.');
        }

        // CQ-016: Wrap all $_POST accesses with wp_unslash() before sanitizing
        // to avoid double-encoded characters from WordPress's magic-quotes layer.
        $payload = [
            'brand_name' => sanitize_text_field((string) wp_unslash($_POST['brand_name'] ?? '')),
            'logo_url' => esc_url_raw((string) wp_unslash($_POST['logo_url'] ?? '')),
            'primary_color' => sanitize_hex_color((string) wp_unslash($_POST['primary_color'] ?? '')) ?: '#1f2937',
            'accent_color' => sanitize_hex_color((string) wp_unslash($_POST['accent_color'] ?? '')) ?: '#22c55e',
            'footer_text' => sanitize_textarea_field((string) wp_unslash($_POST['footer_text'] ?? '')),
            'hide_baseline_branding' => !empty($_POST['hide_baseline_branding'])
        ];

        $response = $this->api_request('PUT', '/v1/sites/' . rawurlencode($siteId) . '/branding', $payload);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('baseline-branding', 'error', $response->get_error_message());
        }

        $this->redirect_with_notice('baseline-branding', 'success', 'Branding saved.');
    }

    public function handle_start_checkout(): void
    {
        $this->ensure_admin_post('baseline_start_checkout');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('baseline-billing', 'error', 'Connect the site before starting checkout.');
        }

        $planId = sanitize_key((string) wp_unslash($_POST['plan_id'] ?? ''));
        if (!in_array($planId, ['starter', 'growth', 'agency'], true)) {
            $this->redirect_with_notice('baseline-billing', 'error', 'Invalid plan selected.');
        }

        $successUrl = add_query_arg(
            [
                'page' => 'baseline-billing',
                'baseline_notice' => 'success',
                'baseline_message' => 'Checkout complete. Billing status may take up to 60 seconds to refresh.'
            ],
            admin_url('admin.php')
        );

        $cancelUrl = add_query_arg(
            [
                'page' => 'baseline-billing',
                'baseline_notice' => 'error',
                'baseline_message' => 'Checkout canceled.'
            ],
            admin_url('admin.php')
        );

        $payload = [
            'plan_id' => $planId,
            'success_url' => $successUrl,
            'cancel_url' => $cancelUrl
        ];

        $response = $this->api_request('POST', '/v1/sites/' . rawurlencode($siteId) . '/billing/checkout-session', $payload);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('baseline-billing', 'error', $response->get_error_message());
        }

        $checkoutUrl = esc_url_raw((string) ($response['data']['checkout_url'] ?? ''));
        if ($checkoutUrl === '' || !preg_match('#^https://#', $checkoutUrl)) {
            $this->redirect_with_notice('baseline-billing', 'error', 'Checkout URL missing from API response.');
        }

        wp_redirect($checkoutUrl);
        exit;
    }

    public function handle_poll_scan(): void
    {
        if (!current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'forbidden'], 403);
        }

        $nonce = sanitize_text_field((string) wp_unslash($_REQUEST['nonce'] ?? ''));
        if (!wp_verify_nonce($nonce, 'baseline_poll_scan')) {
            wp_send_json_error(['message' => 'invalid_nonce'], 403);
        }

        $scanId = sanitize_text_field((string) wp_unslash($_REQUEST['scan_id'] ?? ''));
        if ($scanId === '') {
            $lastScan = $this->fetch_last_scan();
            if (is_wp_error($lastScan) || empty($lastScan) || !is_array($lastScan['data']['scan'] ?? null)) {
                wp_send_json_error(['message' => 'scan_not_found'], 404);
            }
            $scanRow = $lastScan['data']['scan'];
        } else {
            $scanResponse = $this->api_request('GET', '/v1/scans/' . rawurlencode($scanId));
            if (is_wp_error($scanResponse) || !is_array($scanResponse['data']['scan'] ?? null)) {
                wp_send_json_error(['message' => 'scan_not_found'], 404);
            }
            $scanRow = $scanResponse['data']['scan'];
        }

        wp_send_json_success($this->build_scan_status_payload($scanRow));
    }

    public function handle_cancel_scan_ajax(): void
    {
        if (!current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'forbidden'], 403);
        }

        $nonce = sanitize_text_field((string) wp_unslash($_REQUEST['nonce'] ?? ''));
        if (!wp_verify_nonce($nonce, 'baseline_cancel_scan')) {
            wp_send_json_error(['message' => 'invalid_nonce'], 403);
        }

        $scanId = sanitize_text_field((string) wp_unslash($_REQUEST['scan_id'] ?? ''));
        if ($scanId === '') {
            wp_send_json_error(['message' => 'missing_scan_id'], 400);
        }

        $response = $this->api_request('POST', '/v1/scans/' . rawurlencode($scanId) . '/cancel', [
            'reason' => 'Cancelled by administrator from WordPress.'
        ]);
        if (is_wp_error($response)) {
            wp_send_json_error(['message' => $response->get_error_message()], 400);
        }

        wp_send_json_success([
            'scan_id' => sanitize_text_field((string) ($response['data']['scan_id'] ?? $scanId)),
            'status' => sanitize_key((string) ($response['data']['status'] ?? 'cancelled')),
            'summary' => is_array($response['data']['summary'] ?? null) ? $response['data']['summary'] : []
        ]);
    }

    public function handle_cancel_scan(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized request');
        }
        check_admin_referer('baseline_cancel_scan', 'baseline_cancel_scan_nonce');

        $scanId = sanitize_text_field((string) wp_unslash($_POST['baseline_scan_id'] ?? ''));
        $postId = absint(wp_unslash($_POST['baseline_post_id'] ?? 0));
        $page = sanitize_key((string) wp_unslash($_POST['baseline_page'] ?? 'baseline-scan'));
        if (!in_array($page, ['baseline-dashboard', 'baseline-scan'], true)) {
            $page = 'baseline-scan';
        }

        if ($scanId === '') {
            if ($postId > 0) {
                $this->redirect_to_post_with_notice($postId, 'error', 'Scan ID missing for cancel action.');
            }
            $this->redirect_with_notice($page, 'error', 'Scan ID missing for cancel action.');
        }

        $response = $this->api_request('POST', '/v1/scans/' . rawurlencode($scanId) . '/cancel', [
            'reason' => 'Cancelled by administrator from WordPress.'
        ]);
        if (is_wp_error($response)) {
            if ($postId > 0) {
                $this->redirect_to_post_with_notice($postId, 'error', $response->get_error_message(), $scanId);
            }
            $this->redirect_with_notice($page, 'error', $response->get_error_message(), $scanId);
        }

        $message = 'Scan cancelled.';
        if (!empty($response['data']['already_terminal'])) {
            $message = 'Scan already reached a terminal state.';
        }

        if ($postId > 0) {
            $this->redirect_to_post_with_notice($postId, 'success', $message, $scanId);
        }
        $this->redirect_with_notice($page, 'success', $message, $scanId);
    }

    private function ensure_admin_post(string $action): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized request');
        }
        check_admin_referer($action);
    }

    private function registration_lock_key(): string
    {
        return 'baseline_register_lock_' . get_current_blog_id();
    }

    private function get_api_base(): string
    {
        $configured = trim($this->get_option(self::OPTION_API_BASE, self::DEFAULT_API_BASE));
        if ($configured === '') {
            $configured = self::DEFAULT_API_BASE;
        }
        $normalized = untrailingslashit($configured);
        if (strcasecmp($normalized, self::LEGACY_API_BASE) === 0) {
            update_option(self::OPTION_API_BASE, self::DEFAULT_API_BASE);
            return self::DEFAULT_API_BASE;
        }
        return $normalized;
    }

    private function get_option(string $key, string $default = ''): string
    {
        $value = get_option($key, $default);
        return is_string($value) ? $value : $default;
    }

    private function clamp_progress(int $value): int
    {
        return (int) max(0, min(100, $value));
    }

    private function extract_progress_snapshot(array $summary): array
    {
        $progress = isset($summary['progress']) && is_array($summary['progress']) ? $summary['progress'] : [];

        $totalUrls = isset($progress['total_urls']) && is_numeric($progress['total_urls']) ? (int) $progress['total_urls'] : 0;
        $completedUrls = isset($progress['completed_urls']) && is_numeric($progress['completed_urls']) ? (int) $progress['completed_urls'] : 0;
        $currentIndex = isset($progress['current_index']) && is_numeric($progress['current_index']) ? (int) $progress['current_index'] : 0;
        $percentFromObject = isset($progress['percent']) && is_numeric($progress['percent']) ? (int) round((float) $progress['percent']) : null;
        $percentFromTop = isset($summary['progress_percent']) && is_numeric($summary['progress_percent']) ? (int) round((float) $summary['progress_percent']) : null;
        $currentUrl = esc_url_raw((string) ($progress['current_url'] ?? ($summary['current_url'] ?? '')));
        $lastUpdateAt = sanitize_text_field((string) ($progress['last_update_at'] ?? ($summary['callback_received_at'] ?? '')));

        $percent = null;
        if ($percentFromObject !== null) {
            $percent = $this->clamp_progress($percentFromObject);
        } elseif ($percentFromTop !== null) {
            $percent = $this->clamp_progress($percentFromTop);
        } elseif ($totalUrls > 0 && $completedUrls >= 0) {
            $percent = $this->clamp_progress((int) round(($completedUrls / $totalUrls) * 100));
        }

        return [
            'percent' => $percent,
            'total_urls' => $totalUrls,
            'completed_urls' => max(0, $completedUrls),
            'current_index' => max(0, $currentIndex),
            'phase' => sanitize_key((string) ($progress['phase'] ?? '')),
            'current_url' => $currentUrl,
            'last_update_at' => $lastUpdateAt
        ];
    }

    private function extract_current_scan_url(array $summary, array $scanRow, string $status = ''): string
    {
        $progress = isset($summary['progress']) && is_array($summary['progress']) ? $summary['progress'] : [];
        $statusNormalized = sanitize_key($status);
        $isActiveScan = in_array($statusNormalized, ['queued', 'queued_local', 'dispatched', 'running'], true);
        $sampleUrl = '';
        if (isset($summary['issues_sample']) && is_array($summary['issues_sample']) && !empty($summary['issues_sample'][0]['url'])) {
            $sampleUrl = (string) $summary['issues_sample'][0]['url'];
        }

        $candidates = [
            $progress['current_url'] ?? '',
            $summary['current_url'] ?? '',
            $progress['last_completed_url'] ?? '',
            $summary['last_completed_url'] ?? '',
            $scanRow['target_url'] ?? '',
            $summary['target_url'] ?? '',
            $summary['dispatch']['target_url'] ?? ''
        ];

        if (!$isActiveScan) {
            $candidates[] = $summary['dispatch']['site_url'] ?? '';
            $candidates[] = $sampleUrl;
        }

        foreach ($candidates as $candidate) {
            $value = esc_url_raw((string) $candidate);
            if ($value !== '' && preg_match('#^https?://#i', $value)) {
                return $value;
            }
        }

        return '';
    }

    private function build_scan_status_payload(array $scanRow): array
    {
        $summary = $this->extract_scan_summary($scanRow);
        $status = sanitize_key((string) ($scanRow['status'] ?? 'unknown'));
        $progressSnapshot = $this->extract_progress_snapshot($summary);
        $progressPercent = $this->estimate_scan_progress($status, $summary);
        $currentUrl = $this->extract_current_scan_url($summary, $scanRow, $status);
        $targetUrl = esc_url_raw((string) ($scanRow['target_url'] ?? ($summary['target_url'] ?? ($summary['dispatch']['target_url'] ?? ($summary['dispatch']['site_url'] ?? '')))));
        $issuesTotal = $this->extract_issues_total($summary);
        $safety = isset($summary['safety']) && is_array($summary['safety']) ? $summary['safety'] : [];
        $safetyPayload = [
            'mode' => sanitize_key((string) ($safety['mode'] ?? 'strict')),
            'triggered' => !empty($safety['triggered']),
            'reason_code' => sanitize_key((string) ($safety['reason_code'] ?? '')),
            'reason_detail' => sanitize_text_field((string) ($safety['reason_detail'] ?? '')),
            'auto_action' => sanitize_key((string) ($safety['auto_action'] ?? '')),
            'triggered_at' => sanitize_text_field((string) ($safety['triggered_at'] ?? ''))
        ];
        $reportUrl = esc_url_raw((string) ($summary['report_index_url'] ?? ''));
        $workflowUrl = esc_url_raw((string) ($summary['workflow_url'] ?? ($summary['dispatch']['workflow_url'] ?? '')));
        $artifactUrl = esc_url_raw((string) ($summary['reports_artifact_url'] ?? ''));
        $failureInfo = $this->extract_scan_failure_info($summary);

        return [
            'scan_id' => sanitize_text_field((string) ($scanRow['id'] ?? '')),
            'status' => $status,
            'status_label' => sanitize_text_field((string) ($scanRow['status'] ?? 'unknown')),
            'progress_percent' => $progressPercent,
            'run_state' => sanitize_key((string) ($summary['run_state'] ?? '')),
            'created_at' => sanitize_text_field((string) ($scanRow['created_at'] ?? '')),
            'completed_at' => sanitize_text_field((string) ($scanRow['completed_at'] ?? '')),
            'issues_total' => $issuesTotal !== null ? $issuesTotal : 0,
            'severity_text' => $this->format_severity_counts($summary),
            'eta_text' => $this->get_scan_eta_text($status),
            'current_url' => $currentUrl,
            'target_url' => $targetUrl,
            'report_url' => $reportUrl,
            'workflow_url' => $workflowUrl,
            'artifact_url' => $artifactUrl,
            'report_publishing' => $status === 'completed' && $reportUrl === '',
            'progress' => $progressSnapshot,
            'safety' => $safetyPayload,
            'error_code' => $failureInfo['code'],
            'error_message' => $failureInfo['message']
        ];
    }

    private function extract_scan_failure_info(array $summary): array
    {
        $rawCodeCandidates = [
            $summary['dispatch_error'] ?? '',
            $summary['error_code'] ?? '',
            $summary['failure_code'] ?? '',
            $summary['reason_code'] ?? '',
            (is_array($summary['safety'] ?? null) ? ($summary['safety']['reason_code'] ?? '') : '')
        ];

        $code = '';
        foreach ($rawCodeCandidates as $candidate) {
            $value = sanitize_key((string) $candidate);
            if ($value !== '') {
                $code = $value;
                break;
            }
        }

        $rawMessageCandidates = [
            $summary['error_message'] ?? '',
            $summary['failure_reason'] ?? '',
            $summary['error'] ?? '',
            $summary['dispatch_error_message'] ?? '',
            (is_array($summary['safety'] ?? null) ? ($summary['safety']['reason_detail'] ?? '') : '')
        ];

        $message = '';
        foreach ($rawMessageCandidates as $candidate) {
            $value = sanitize_text_field((string) $candidate);
            if ($value !== '') {
                $message = $value;
                break;
            }
        }

        return [
            'code' => $code,
            'message' => $message
        ];
    }

    private function default_scan_options(): array
    {
        return [
            'evidence_enabled' => true,
            'lighthouse_enabled' => true,
            'quick_scan_enabled' => false,
            'responsive_enabled' => false,
            'viewport_preset' => 'desktop'
        ];
    }

    private function sanitize_scan_options($rawValue, array $fallback): array
    {
        $source = is_array($rawValue) ? $rawValue : [];

        $normalized = [
            'evidence_enabled' => $this->sanitize_boolean($source['evidence_enabled'] ?? $fallback['evidence_enabled'], (bool) $fallback['evidence_enabled']),
            'lighthouse_enabled' => $this->sanitize_boolean($source['lighthouse_enabled'] ?? $fallback['lighthouse_enabled'], (bool) $fallback['lighthouse_enabled']),
            'quick_scan_enabled' => $this->sanitize_boolean($source['quick_scan_enabled'] ?? $fallback['quick_scan_enabled'], (bool) $fallback['quick_scan_enabled']),
            'responsive_enabled' => $this->sanitize_boolean($source['responsive_enabled'] ?? $fallback['responsive_enabled'], (bool) $fallback['responsive_enabled']),
            'viewport_preset' => $this->sanitize_viewport_preset($source['viewport_preset'] ?? $fallback['viewport_preset'])
        ];

        if (!$normalized['responsive_enabled']) {
            $normalized['viewport_preset'] = 'desktop';
        }

        return $normalized;
    }

    private function sanitize_boolean($value, bool $fallback): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (is_numeric($value)) {
            return ((int) $value) === 1;
        }

        $normalized = strtolower(trim((string) $value));
        if ($normalized === '') {
            return $fallback;
        }

        if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
            return true;
        }

        if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
            return false;
        }

        return $fallback;
    }

    private function sanitize_viewport_preset($value): string
    {
        $normalized = sanitize_key((string) $value);
        return in_array($normalized, ['desktop', 'mobile', 'both'], true) ? $normalized : 'desktop';
    }

    private function get_scan_defaults(): array
    {
        $raw = get_option(self::OPTION_SCAN_DEFAULTS, $this->default_scan_options());
        return $this->sanitize_scan_options(is_array($raw) ? $raw : [], $this->default_scan_options());
    }

    private function get_post_scan_options(int $postId, array $defaults): array
    {
        $raw = get_post_meta($postId, self::META_SCAN_OPTIONS, true);
        return $this->sanitize_scan_options(is_array($raw) ? $raw : [], $defaults);
    }

    private function get_post_scan_use_defaults(int $postId): bool
    {
        $raw = get_post_meta($postId, self::META_SCAN_USE_SITE_DEFAULTS, true);
        if ($raw === '') {
            return true;
        }
        return $this->sanitize_boolean($raw, true);
    }

    private function get_supported_scan_post_types(): array
    {
        $publicTypes = get_post_types(['public' => true], 'names');
        $excluded = [
            'attachment',
            'revision',
            'nav_menu_item',
            'custom_css',
            'customize_changeset',
            'oembed_cache',
            'user_request',
            'wp_block',
            'wp_navigation',
            'wp_template',
            'wp_template_part',
            'wp_font_family',
            'wp_font_face'
        ];

        $types = array_values(array_diff($publicTypes, $excluded));
        if (!in_array('post', $types, true)) {
            $types[] = 'post';
        }
        if (!in_array('page', $types, true)) {
            $types[] = 'page';
        }

        return array_values(array_unique($types));
    }

    private function get_published_target_url(int $postId): string
    {
        $post = get_post($postId);
        if (!$post instanceof WP_Post || $post->post_status !== 'publish') {
            return '';
        }

        $url = get_permalink($post);
        if (!is_string($url) || $url === '') {
            return '';
        }

        return preg_match('#^https?://#i', $url) ? esc_url_raw($url) : '';
    }

    private function render_metabox_last_scan(int $postId): void
    {
        $scanId = sanitize_text_field((string) get_post_meta($postId, self::META_LAST_SCAN_ID, true));
        echo '<hr />';
        echo '<p><strong>Last Page Scan</strong></p>';

        if ($scanId === '') {
            echo '<p class="description">No page scan started yet for this post.</p>';
            return;
        }

        $scanResponse = $this->api_request('GET', '/v1/scans/' . rawurlencode($scanId));
        if (is_wp_error($scanResponse)) {
            echo '<p class="description">' . esc_html($scanResponse->get_error_message()) . '</p>';
            return;
        }

        $scan = is_array($scanResponse['data']['scan'] ?? null) ? $scanResponse['data']['scan'] : [];
        $summary = $this->extract_scan_summary($scan);
        $status = sanitize_key((string) ($scan['status'] ?? 'unknown'));
        $progress = $this->estimate_scan_progress($status, $summary);
        $currentUrl = $this->extract_current_scan_url($summary, $scan, $status);
        $message = $this->get_scan_eta_text($status);
        $pollUrl = admin_url('admin-ajax.php');
        $pollNonce = wp_create_nonce('baseline_poll_scan');
        $cancelNonce = wp_create_nonce('baseline_cancel_scan');

        $createdAt = sanitize_text_field((string) ($scan['created_at'] ?? ''));
        echo '<div class="baseline-inline-tracker" data-baseline-inline-tracker="1" data-scan-id="' . esc_attr($scanId) . '" data-poll-url="' . esc_url($pollUrl) . '" data-poll-nonce="' . esc_attr($pollNonce) . '" data-cancel-nonce="' . esc_attr($cancelNonce) . '" data-created-at="' . esc_attr($createdAt) . '">';
        echo '<p><strong>ID:</strong> <code>' . esc_html($scanId) . '</code></p>';
        echo '<p><strong>Status:</strong> <span data-baseline-inline-status>' . esc_html($status !== '' ? $status : 'unknown') . '</span></p>';
        echo '<p><strong>Progress:</strong> <span data-baseline-inline-progress-text>' . esc_html((string) $progress) . '%</span></p>';
        echo '<p><strong>Elapsed:</strong> <span data-baseline-inline-elapsed>--</span></p>';
        echo '<div class="baseline-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' . esc_attr((string) $progress) . '" data-baseline-inline-progress-wrap="1">';
        echo '<span data-baseline-inline-progress-bar="1" style="width:' . esc_attr((string) $progress) . '%"></span>';
        echo '</div>';
        echo '<p><strong>Current URL:</strong> <code class="baseline-break-word" data-baseline-inline-current-url>' . esc_html($currentUrl !== '' ? $currentUrl : 'Waiting for live scan telemetry...') . '</code></p>';
        if ($message !== '') {
            echo '<p class="description" data-baseline-inline-message>' . esc_html($message) . '</p>';
        } else {
            echo '<p class="description" data-baseline-inline-message></p>';
        }

        $isRunning = $this->is_scan_in_progress($status);
        echo '<div class="baseline-actions">';
        if (!empty($summary['report_index_url'])) {
            echo '<a class="button button-primary" data-baseline-inline-view-report="1" target="_blank" rel="noopener" href="' . esc_url((string) $summary['report_index_url']) . '">View Report</a>';
        } else {
            echo '<a class="button button-primary is-disabled" data-baseline-inline-view-report="1" aria-disabled="true" href="#">View Report</a>';
        }
        $workflowUrl = (string) ($summary['workflow_url'] ?? ($summary['dispatch']['workflow_url'] ?? ''));
        if (!empty($workflowUrl)) {
            echo '<a class="button" data-baseline-inline-open-run="1" target="_blank" rel="noopener" href="' . esc_url($workflowUrl) . '">Open GitHub Run</a>';
        } else {
            echo '<a class="button is-disabled" data-baseline-inline-open-run="1" aria-disabled="true" href="#">Open GitHub Run</a>';
        }
        if ($isRunning) {
            echo '<button type="button" class="button" data-baseline-inline-stop="1">Stop Scan</button>';
        } else {
            echo '<button type="button" class="button is-disabled" data-baseline-inline-stop="1" aria-disabled="true">Stop Scan</button>';
        }
        echo '</div>';
        echo '</div>';
    }

    private function render_scan_setup_card(array $scanDefaults): void
    {
        echo '<div class="baseline-card baseline-card-scan-setup">';
        echo '<h2>Scan Setup</h2>';
        echo '<p class="baseline-card-intro">Choose the scan profile for this run. Baseline auto-discovers published WordPress pages/posts by default. You can still override per-page scans from post/page edit screens.</p>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" class="baseline-scan-config-form">';
        echo '<input type="hidden" name="action" value="baseline_run_scan" />';
        wp_nonce_field('baseline_run_scan');

        echo '<div class="baseline-scan-section">';
        echo '<h3>Scope</h3>';
        echo '<p><label for="baseline_form_mode"><strong>Form Mode</strong></label><br />';
        echo '<select id="baseline_form_mode" name="form_mode">';
        $defaultMode = $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run');
        echo '<option value="dry-run"' . selected($defaultMode, 'dry-run', false) . '>dry-run</option>';
        echo '<option value="live"' . selected($defaultMode, 'live', false) . '>live</option>';
        echo '</select></p>';
        echo '<p><label for="baseline_sitemap_url"><strong>Sitemap URL (optional override)</strong></label><br />';
        echo '<input class="regular-text" type="url" id="baseline_sitemap_url" name="sitemap_url" placeholder="Only needed if you want to force a custom sitemap source." /></p>';
        echo '</div>';

        echo '<div class="baseline-scan-section">';
        echo '<h3>Performance/Coverage</h3>';
        $this->render_toggle_field('scan_options[quick_scan_enabled]', 'baseline_quick_scan', !empty($scanDefaults['quick_scan_enabled']), 'Quick scan', 'Runs a faster reduced project set for quicker feedback (example: ~2–4 min vs full run).');
        $this->render_toggle_field('scan_options[responsive_enabled]', 'baseline_responsive_scan', !empty($scanDefaults['responsive_enabled']), 'Responsive scan', 'Tests mobile/tablet layouts for breakpoint issues (example: overlapping buttons on 390px width).');

        $viewportVisibleClass = !empty($scanDefaults['responsive_enabled']) ? '' : ' is-hidden';
        echo '<div class="baseline-field' . esc_attr($viewportVisibleClass) . '" data-baseline-viewport-wrap="dashboard">';
        echo '<label for="baseline_viewport_preset"><strong>Viewport preset</strong></label>' . $this->render_help_tip('Choose which device classes to test: Desktop, Mobile, or Both.') . '<br />';
        echo '<select id="baseline_viewport_preset" name="scan_options[viewport_preset]" data-baseline-viewport-select="dashboard">';
        echo '<option value="desktop"' . selected($scanDefaults['viewport_preset'], 'desktop', false) . '>Desktop</option>';
        echo '<option value="mobile"' . selected($scanDefaults['viewport_preset'], 'mobile', false) . '>Mobile</option>';
        echo '<option value="both"' . selected($scanDefaults['viewport_preset'], 'both', false) . '>Both</option>';
        echo '</select>';
        echo '</div>';
        echo '</div>';

        echo '<div class="baseline-scan-section">';
        echo '<h3>Evidence</h3>';
        $this->render_toggle_field('scan_options[evidence_enabled]', 'baseline_evidence_enabled', !empty($scanDefaults['evidence_enabled']), 'Evidence', 'Captures screenshot proof for detected issues (example: missing alt text evidence).');
        $this->render_toggle_field('scan_options[lighthouse_enabled]', 'baseline_lighthouse_enabled', !empty($scanDefaults['lighthouse_enabled']), 'Lighthouse', 'Runs Lighthouse audits for performance/SEO/accessibility metrics (example: LCP, CLS, SEO score).');
        echo '</div>';

        echo '<p class="baseline-summary-line"><strong>Selected profile summary:</strong> <span id="baseline-dashboard-summary-text"></span></p>';

        submit_button('Start Scan', 'primary baseline-primary-cta', 'submit', false);
        echo '</form>';
        echo '</div>';
    }

    private function render_latest_scan_card($lastScan, array $latestScanRow, string $lastCompletedReportUrl = ''): void
    {
        echo '<div class="baseline-card baseline-card-latest">';
        echo '<h2>Latest Scan</h2>';
        if (is_wp_error($lastScan)) {
            echo '<p>' . esc_html($lastScan->get_error_message()) . '</p>';
            echo '</div>';
            return;
        }

        if (empty($latestScanRow)) {
            echo '<p>No scans started yet.</p>';
            echo '</div>';
            return;
        }

        $scan = $latestScanRow;
        $scanSummary = $this->extract_scan_summary($scan);
        $scanStatus = sanitize_key((string) ($scan['status'] ?? ''));
        $scanId = sanitize_text_field((string) ($scan['id'] ?? ''));
        $reportPdfUrl = esc_url_raw((string) ($scanSummary['report_pdf_url'] ?? ''));
        $reportZipUrl = esc_url_raw((string) ($scanSummary['report_share_zip_url'] ?? ''));
        echo '<ul class="baseline-kv-list">';
        echo '<li><span>ID</span><code>' . esc_html((string) ($scan['id'] ?? 'n/a')) . '</code></li>';
        echo '<li><span>Status</span>' . $this->render_status_pill((string) ($scan['status'] ?? 'n/a')) . '</li>';
        echo '<li><span>Created</span><strong>' . esc_html((string) ($scan['created_at'] ?? 'n/a')) . '</strong></li>';
        echo '<li><span>Completed</span><strong>' . esc_html((string) ($scan['completed_at'] ?? 'pending')) . '</strong></li>';

        $targetUrl = sanitize_text_field((string) ($scan['target_url'] ?? ($scanSummary['target_url'] ?? '')));
        if ($targetUrl !== '') {
            echo '<li><span>Target URL</span><span class="baseline-break-word"><code>' . esc_html($targetUrl) . '</code></span></li>';
        }

        $scanOptions = $this->extract_scan_options($scan, $scanSummary);
        if (!empty($scanOptions)) {
            echo '<li><span>Profile</span><strong>' . esc_html($this->format_scan_options_summary($scanOptions)) . '</strong></li>';
        }
        echo '</ul>';

        $progressPercent = $this->estimate_scan_progress($scanStatus, $scanSummary);
        echo '<p><strong>Progress:</strong> ' . esc_html((string) $progressPercent) . '%</p>';
        echo '<div class="baseline-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' . esc_attr((string) $progressPercent) . '">';
        echo '<span style="width:' . esc_attr((string) $progressPercent) . '%"></span>';
        echo '</div>';

        $currentUrl = $this->extract_current_scan_url($scanSummary, $scan, $scanStatus);
        if ($currentUrl !== '') {
            echo '<p><strong>Current URL:</strong> <code class="baseline-break-word">' . esc_html($currentUrl) . '</code></p>';
        }

        $etaText = $this->get_scan_eta_text($scanStatus);
        if ($etaText !== '') {
            echo '<p class="description">' . esc_html($etaText) . '</p>';
        }

        if ($this->is_scan_in_progress($scanStatus)) {
            echo '<p class="description">Live scan progress is available in the tracker modal while your scan is running.</p>';
            echo '<div class="baseline-actions">';
            echo '<button type="button" class="button" data-baseline-open-scan-modal="1">Track Live Scan</button>';
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" class="baseline-inline-form">';
            echo '<input type="hidden" name="action" value="baseline_cancel_scan" />';
            echo '<input type="hidden" name="baseline_page" value="baseline-scan" />';
            echo '<input type="hidden" name="baseline_scan_id" value="' . esc_attr($scanId) . '" />';
            wp_nonce_field('baseline_cancel_scan', 'baseline_cancel_scan_nonce');
            echo '<button type="submit" class="button">Stop Scan</button>';
            echo '</form>';
            echo '<a class="button" href="' . esc_url(admin_url('admin.php?page=baseline-scan')) . '">Refresh Now</a>';
            echo '</div>';
        }

        $issuesTotal = $this->extract_issues_total($scanSummary);
        if ($issuesTotal !== null) {
            echo '<p><strong>Issues:</strong> ' . esc_html((string) $issuesTotal) . '</p>';
        }

        $severityText = $this->format_severity_counts($scanSummary);
        if ($severityText !== '') {
            echo '<p><strong>Severity:</strong> ' . esc_html($severityText) . '</p>';
        }

        if (!empty($scanSummary['run_state'])) {
            echo '<p><strong>Run State:</strong> ' . esc_html((string) $scanSummary['run_state']) . '</p>';
        }
        $failureInfo = $this->extract_scan_failure_info($scanSummary);
        if (in_array($scanStatus, ['failed', 'cancelled', 'protected_stopped', 'stalled'], true)) {
            if ($failureInfo['code'] !== '') {
                echo '<p><strong>Error Code:</strong> <code>' . esc_html($failureInfo['code']) . '</code></p>';
            }
            if ($failureInfo['message'] !== '') {
                echo '<p><strong>Error Detail:</strong> ' . esc_html($failureInfo['message']) . '</p>';
            }
        }
        if ($scanStatus === 'stalled') {
            echo '<p class="description">Scan stalled due to missing progress telemetry. Retry with safe profile.</p>';
        }
        if ($scanStatus === 'protected_stopped') {
            echo '<p class="description">Site protection triggered. Scan auto-stopped to protect uptime.</p>';
        }

        $hasReport = !empty($scanSummary['report_index_url']);
        if ($scanStatus === 'completed' && !$hasReport) {
            echo '<p class="description">Report is still publishing. Retry in a few seconds, or use fallback links below.</p>';
        }

        echo '<div class="baseline-actions">';
        if (!empty($scanSummary['report_index_url'])) {
            echo '<a class="button button-primary" target="_blank" rel="noopener" href="' . esc_url((string) $scanSummary['report_index_url']) . '">View Report</a>';
        } elseif ($scanStatus === 'completed') {
            echo '<a class="button button-primary" href="' . esc_url(add_query_arg(['page' => 'baseline-scan'], admin_url('admin.php'))) . '">Retry Report Link</a>';
        }

        $workflowUrl = (string) ($scanSummary['workflow_url'] ?? ($scanSummary['dispatch']['workflow_url'] ?? ''));
        if (!empty($workflowUrl)) {
            echo '<a class="button" target="_blank" rel="noopener" href="' . esc_url($workflowUrl) . '">Open GitHub Run</a>';
        }

        if ($reportPdfUrl !== '') {
            echo '<a class="button" target="_blank" rel="noopener" href="' . esc_url($reportPdfUrl) . '">Download PDF</a>';
        }

        if ($reportZipUrl !== '') {
            echo '<a class="button" target="_blank" rel="noopener" href="' . esc_url($reportZipUrl) . '">Download Evidence ZIP</a>';
        }
        if (in_array($scanStatus, ['failed', 'cancelled', 'protected_stopped', 'stalled'], true)) {
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" class="baseline-inline-form">';
            echo '<input type="hidden" name="action" value="baseline_run_scan" />';
            echo '<input type="hidden" name="form_mode" value="dry-run" />';
            echo '<input type="hidden" name="scan_options[evidence_enabled]" value="1" />';
            echo '<input type="hidden" name="scan_options[lighthouse_enabled]" value="0" />';
            echo '<input type="hidden" name="scan_options[quick_scan_enabled]" value="1" />';
            echo '<input type="hidden" name="scan_options[responsive_enabled]" value="0" />';
            echo '<input type="hidden" name="scan_options[viewport_preset]" value="desktop" />';
            wp_nonce_field('baseline_run_scan');
            echo '<button type="submit" class="button">Retry Safe Scan</button>';
            echo '</form>';
        }
        if ($lastCompletedReportUrl !== '') {
            echo '<a class="button" target="_blank" rel="noopener" href="' . esc_url($lastCompletedReportUrl) . '">View Last Completed Report</a>';
        }
        echo '</div>';

        $evidenceText = $this->format_evidence_counts($scanSummary);
        if ($evidenceText !== '') {
            echo '<p><strong>Evidence:</strong> ' . esc_html($evidenceText) . '</p>';
        }
        echo '</div>';
    }

    private function render_recent_scans_card($scans): void
    {
        echo '<div class="baseline-card baseline-card-recent">';
        echo '<h2>Recent Scans</h2>';
        if (is_wp_error($scans)) {
            echo '<p>' . esc_html($scans->get_error_message()) . '</p>';
            echo '</div>';
            return;
        }

        $rows = $scans['data']['scans'] ?? [];
        if (empty($rows)) {
            echo '<p>No scan history yet.</p>';
            echo '</div>';
            return;
        }

        echo '<div class="baseline-table-wrap">';
        echo '<table class="widefat striped baseline-table">';
        echo '<thead><tr><th>Scan ID</th><th>Status</th><th>Mode</th><th>Issues</th><th>Report</th><th>Created</th></tr></thead><tbody>';
        foreach ($rows as $row) {
            $rowSummary = $this->extract_scan_summary($row);
            $rowIssues = $this->extract_issues_total($rowSummary);
            $reportUrl = (string) ($rowSummary['report_index_url'] ?? ($rowSummary['workflow_url'] ?? ($rowSummary['dispatch']['workflow_url'] ?? ($rowSummary['reports_artifact_url'] ?? ''))));
            echo '<tr>';
            echo '<td>' . esc_html((string) ($row['id'] ?? '')) . '</td>';
            echo '<td>' . $this->render_status_pill((string) ($row['status'] ?? '')) . '</td>';
            echo '<td>' . esc_html((string) ($row['form_mode'] ?? '')) . '</td>';
            echo '<td>' . esc_html($rowIssues !== null ? (string) $rowIssues : 'n/a') . '</td>';
            if ($reportUrl !== '') {
                echo '<td><a target="_blank" rel="noopener" href="' . esc_url($reportUrl) . '">Open</a></td>';
            } else {
                echo '<td>n/a</td>';
            }
            echo '<td>' . esc_html((string) ($row['created_at'] ?? '')) . '</td>';
            echo '</tr>';
        }
        echo '</tbody></table>';
        echo '</div>';
        echo '</div>';
    }

    private function render_toggle_field(string $name, string $id, bool $checkedValue, string $label, string $tooltip): void
    {
        echo '<div class="baseline-field">';
        echo '<input type="hidden" name="' . esc_attr($name) . '" value="0" />';
        echo '<label class="baseline-toggle-row" for="' . esc_attr($id) . '">';
        echo '<input type="checkbox" id="' . esc_attr($id) . '" name="' . esc_attr($name) . '" value="1" ' . checked($checkedValue, true, false) . ' />';
        echo '<span><strong>' . esc_html($label) . '</strong></span>';
        echo '</label>';
        echo $this->render_help_tip($tooltip);
        echo '</div>';
    }

    private function find_last_completed_report_url($scans): string
    {
        if (is_wp_error($scans)) {
            return '';
        }
        $rows = $scans['data']['scans'] ?? [];
        if (!is_array($rows) || empty($rows)) {
            return '';
        }

        foreach ($rows as $row) {
            $status = sanitize_key((string) ($row['status'] ?? ''));
            if ($status !== 'completed') {
                continue;
            }
            $summary = $this->extract_scan_summary($row);
            $url = esc_url_raw((string) ($summary['report_index_url'] ?? ''));
            if ($url !== '') {
                return $url;
            }
        }

        return '';
    }

    private function render_scan_option_rows(array $options, string $namePrefix): void
    {
        $this->render_toggle_field($namePrefix . '[evidence_enabled]', $namePrefix . '_evidence_enabled', !empty($options['evidence_enabled']), 'Evidence', 'Captures screenshot proof for detected issues (example: missing alt text evidence).');
        $this->render_toggle_field($namePrefix . '[lighthouse_enabled]', $namePrefix . '_lighthouse_enabled', !empty($options['lighthouse_enabled']), 'Lighthouse', 'Runs Lighthouse audits for performance/SEO/accessibility metrics (example: LCP, CLS, SEO score).');
        $this->render_toggle_field($namePrefix . '[quick_scan_enabled]', $namePrefix . '_quick_scan_enabled', !empty($options['quick_scan_enabled']), 'Quick scan', 'Runs a faster reduced project set for quicker feedback (example: ~2–4 min vs full run).');
        $this->render_toggle_field($namePrefix . '[responsive_enabled]', $namePrefix . '_responsive_enabled', !empty($options['responsive_enabled']), 'Responsive scan', 'Tests mobile/tablet layouts for breakpoint issues (example: overlapping buttons on 390px width).');

        $wrapperClass = !empty($options['responsive_enabled']) ? 'baseline-field' : 'baseline-field is-hidden';
        echo '<div class="' . esc_attr($wrapperClass) . '" data-baseline-viewport-wrap="' . esc_attr($namePrefix) . '">';
        echo '<label for="' . esc_attr($namePrefix . '_viewport_preset') . '"><strong>Viewport preset</strong></label>' . $this->render_help_tip('Choose which device classes to test: Desktop, Mobile, or Both.') . '<br />';
        echo '<select class="widefat" id="' . esc_attr($namePrefix . '_viewport_preset') . '" name="' . esc_attr($namePrefix . '[viewport_preset]') . '" data-baseline-viewport-select="' . esc_attr($namePrefix) . '">';
        echo '<option value="desktop"' . selected($options['viewport_preset'], 'desktop', false) . '>Desktop</option>';
        echo '<option value="mobile"' . selected($options['viewport_preset'], 'mobile', false) . '>Mobile</option>';
        echo '<option value="both"' . selected($options['viewport_preset'], 'both', false) . '>Both</option>';
        echo '</select>';
        echo '</div>';
    }

    private function render_scan_progress_modal(string $scanId, bool $autoOpen, string $lastCompletedReportUrl = ''): void
    {
        if ($scanId === '') {
            return;
        }

        $pollUrl = admin_url('admin-ajax.php');
        $pollNonce = wp_create_nonce('baseline_poll_scan');
        $cancelNonce = wp_create_nonce('baseline_cancel_scan');

        echo '<div id="baseline-scan-progress-modal" class="baseline-modal" data-auto-open="' . ($autoOpen ? '1' : '0') . '" data-scan-id="' . esc_attr($scanId) . '" data-poll-url="' . esc_url($pollUrl) . '" data-poll-nonce="' . esc_attr($pollNonce) . '" data-cancel-nonce="' . esc_attr($cancelNonce) . '" data-last-report-url="' . esc_url($lastCompletedReportUrl) . '" aria-hidden="true">';
        echo '<div class="baseline-modal__backdrop" data-baseline-modal-close="1"></div>';
        echo '<div class="baseline-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="baseline-modal-title">';
        echo '<div class="baseline-modal__header">';
        echo '<h2 id="baseline-modal-title">Scan In Progress</h2>';
        echo '<button type="button" class="button-link" data-baseline-modal-close="1" aria-label="Close">Close</button>';
        echo '</div>';
        echo '<div class="baseline-modal__body">';
        echo '<div class="baseline-modal__meta"><strong>Scan ID:</strong> <code id="baseline-modal-scan-id">' . esc_html($scanId) . '</code></div>';
        echo '<div class="baseline-modal__meta"><strong>Status:</strong> <span id="baseline-modal-status">queued</span></div>';
        echo '<div class="baseline-modal__meta"><strong>Progress:</strong> <span id="baseline-modal-progress-text">0%</span></div>';
        echo '<div class="baseline-progress baseline-modal__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">';
        echo '<span id="baseline-modal-progress-bar" style="width:0%"></span>';
        echo '</div>';
        echo '<div class="baseline-modal__ticker"><strong>Current URL:</strong> <code id="baseline-modal-current-url">Waiting for live scan telemetry...</code></div>';
        echo '<div class="baseline-modal__ticker"><strong>Elapsed:</strong> <span id="baseline-modal-elapsed">--</span></div>';
        echo '<div class="baseline-modal__ticker" id="baseline-modal-status-message">Scan is queued.</div>';
        echo '<div class="baseline-modal__ticker"><strong>QA tip:</strong> <span id="baseline-modal-tip-text">Checking forms and broken links first usually finds the highest-impact conversion issues.</span></div>';
        echo '<div class="baseline-modal__ticker muted" id="baseline-modal-eta-text"></div>';
        echo '</div>';
        echo '<div class="baseline-modal__footer">';
        echo '<a id="baseline-modal-view-report" class="button button-primary" href="#" target="_blank" rel="noopener" aria-disabled="true">View Report</a>';
        echo '<a id="baseline-modal-open-workflow" class="button" href="#" target="_blank" rel="noopener" aria-disabled="true">Open GitHub Run</a>';
        echo '<a id="baseline-modal-download-artifact" class="button" href="#" target="_blank" rel="noopener" aria-disabled="true">Download Report ZIP</a>';
        echo '<a id="baseline-modal-last-report" class="button" href="' . esc_url($lastCompletedReportUrl !== '' ? $lastCompletedReportUrl : '#') . '" target="_blank" rel="noopener" aria-disabled="' . ($lastCompletedReportUrl !== '' ? 'false' : 'true') . '">View Last Completed Report</a>';
        echo '<button type="button" id="baseline-modal-retry-safe" class="button">Retry Safe Scan</button>';
        echo '<button type="button" id="baseline-modal-stop" class="button">Stop Scan</button>';
        echo '<button type="button" class="button" data-baseline-modal-close="1">Close</button>';
        echo '</div>';
        echo '<form id="baseline-modal-retry-safe-form" method="post" action="' . esc_url(admin_url('admin-post.php')) . '" class="baseline-hidden-form">';
        echo '<input type="hidden" name="action" value="baseline_run_scan" />';
        echo '<input type="hidden" name="form_mode" value="dry-run" />';
        echo '<input type="hidden" name="scan_options[evidence_enabled]" value="1" />';
        echo '<input type="hidden" name="scan_options[lighthouse_enabled]" value="0" />';
        echo '<input type="hidden" name="scan_options[quick_scan_enabled]" value="1" />';
        echo '<input type="hidden" name="scan_options[responsive_enabled]" value="0" />';
        echo '<input type="hidden" name="scan_options[viewport_preset]" value="desktop" />';
        wp_nonce_field('baseline_run_scan', '_wpnonce', true, true);
        echo '</form>';
        echo '</div>';
        echo '</div>';
    }

    private function render_help_tip(string $text): string
    {
        return ' <span class="dashicons dashicons-editor-help baseline-help-tip" title="' . esc_attr($text) . '" aria-label="' . esc_attr($text) . '"></span>';
    }

    private function render_scan_form_script(): void
    {
        $scriptPath = BASELINE_PLUGIN_DIR . 'assets/js/admin-scan.js';
        $scriptVersion = file_exists($scriptPath) ? (string) filemtime($scriptPath) : BASELINE_VERSION;
        wp_enqueue_script('baseline-admin-scan', BASELINE_PLUGIN_URL . 'assets/js/admin-scan.js', [], $scriptVersion, true);
    }

    private function api_request(string $method, string $path, ?array $body = null, bool $includeSiteToken = true)
    {
        $base = $this->get_api_base();
        if ($base === '') {
            return new WP_Error('baseline_api_base_missing', 'Set API Base URL in Baseline Settings first.');
        }

        $url = $base . '/' . ltrim($path, '/');
        $headers = ['Accept' => 'application/json'];

        if ($includeSiteToken) {
            $siteToken = trim($this->get_option(self::OPTION_SITE_TOKEN));
            if ($siteToken !== '') {
                // Send all accepted auth headers for backward compatibility.
                $headers['x-launchguard-site-token'] = $siteToken;
                $headers['x-site-token'] = $siteToken;
                $headers['Authorization'] = 'Bearer ' . $siteToken;
                $headers['x-baseline-site-token'] = $siteToken;
            }
        }

        $args = [
            'method' => strtoupper($method),
            'timeout' => 25,
            'headers' => $headers
        ];

        if ($body !== null) {
            $args['headers']['Content-Type'] = 'application/json';
            $args['body'] = wp_json_encode($body);
        }

        $response = wp_remote_request($url, $args);
        if (is_wp_error($response)) {
            $this->log_api_error($method, $path, 0, $response->get_error_message(), $body);
            return $response;
        }

        $status = wp_remote_retrieve_response_code($response);
        $rawBody = wp_remote_retrieve_body($response);
        $data = json_decode($rawBody, true);
        if (!is_array($data)) {
            $data = ['raw' => $rawBody];
        }

        if ($status >= 400) {
            $message = (string) ($data['error'] ?? ('API request failed with status ' . $status));
            $this->log_api_error($method, $path, $status, $message, $body, $rawBody);
            return new WP_Error('baseline_api_error', $message);
        }

        return [
            'status' => $status,
            'data' => $data
        ];
    }

    private function fetch_limits(string $siteId)
    {
        return $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/limits');
    }

    private function fetch_billing(string $siteId)
    {
        return $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/billing');
    }

    private function extract_plan_features($response): array
    {
        if (is_wp_error($response)) {
            return [
                'pdf_export' => false,
                'zip_export' => false,
                'whitelabel' => false
            ];
        }

        $data = is_array($response['data'] ?? null) ? $response['data'] : [];
        return [
            'pdf_export' => !empty($data['pdf_export']),
            'zip_export' => !empty($data['zip_export']),
            'whitelabel' => !empty($data['whitelabel'])
        ];
    }

    private function fetch_scans(string $siteId, int $limit)
    {
        return $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/scans?limit=' . max(1, min(50, $limit)));
    }

    private function fetch_last_scan()
    {
        $scanId = $this->get_option(self::OPTION_LAST_SCAN_ID);
        if ($scanId === '') {
            return null;
        }
        return $this->api_request('GET', '/v1/scans/' . rawurlencode($scanId));
    }

    private function extract_scan_summary(array $scanRow): array
    {
        if (isset($scanRow['summary']) && is_array($scanRow['summary'])) {
            return $scanRow['summary'];
        }

        if (!empty($scanRow['summary_json']) && is_string($scanRow['summary_json'])) {
            $decoded = json_decode($scanRow['summary_json'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return [];
    }

    private function extract_scan_options(array $scanRow, array $summary): array
    {
        $fromSummary = $summary['scan_options'] ?? null;
        if (is_array($fromSummary)) {
            return $fromSummary;
        }

        $fromScan = $scanRow['scan_options'] ?? null;
        if (is_array($fromScan)) {
            return $fromScan;
        }

        return [];
    }

    private function is_scan_in_progress(string $status): bool
    {
        return in_array($status, ['queued', 'queued_local', 'running', 'dispatched'], true);
    }

    private function estimate_scan_progress(string $status, array $summary): int
    {
        $progressSnapshot = $this->extract_progress_snapshot($summary);
        if ($progressSnapshot['percent'] !== null) {
            return $this->clamp_progress((int) $progressSnapshot['percent']);
        }

        if ($status === 'completed') {
            return 100;
        }

        if (in_array($status, ['failed', 'cancelled', 'protected_stopped', 'stalled'], true)) {
            return 100;
        }

        $runState = sanitize_key((string) ($summary['run_state'] ?? ''));
        if ($runState === 'complete') {
            return 100;
        }

        if ($runState === 'partial') {
            return 90;
        }

        if ($status === 'dispatched') {
            return 70;
        }

        if ($status === 'running') {
            return 45;
        }

        if ($status === 'queued_local') {
            return 20;
        }

        if ($status === 'queued') {
            return 10;
        }

        return 0;
    }

    private function get_scan_eta_text(string $status): string
    {
        if ($status === 'queued' || $status === 'queued_local') {
            return 'Queued for processing. Expected start time is usually under 1 minute.';
        }

        if ($status === 'running' || $status === 'dispatched') {
            return 'Scan is running in the cloud. Typical quick-scan duration is about 2 to 6 minutes.';
        }

        if ($status === 'completed') {
            return 'Scan complete. Use View Report to open the HTML report directly.';
        }

        if ($status === 'failed') {
            return 'Scan failed. Check the latest run link and retry the scan.';
        }

        if ($status === 'cancelled') {
            return 'Scan was cancelled.';
        }

        if ($status === 'protected_stopped') {
            return 'Site under stress; scan auto-stopped to protect uptime. Retry in safe mode.';
        }

        if ($status === 'stalled') {
            return 'Scan stalled due to missing progress updates. Retry with safe profile.';
        }

        return '';
    }

    private function extract_issues_total(array $summary): ?int
    {
        if (isset($summary['issue_summary_total']) && is_numeric($summary['issue_summary_total'])) {
            return (int) $summary['issue_summary_total'];
        }

        if (isset($summary['issues_total']) && is_numeric($summary['issues_total'])) {
            return (int) $summary['issues_total'];
        }

        if (isset($summary['run_counts']) && is_array($summary['run_counts']) && isset($summary['run_counts']['summaryRows']) && is_numeric($summary['run_counts']['summaryRows'])) {
            return (int) $summary['run_counts']['summaryRows'];
        }

        if (isset($summary['run_counts']) && is_array($summary['run_counts']) && isset($summary['run_counts']['issueRows']) && is_numeric($summary['run_counts']['issueRows'])) {
            return (int) $summary['run_counts']['issueRows'];
        }

        return null;
    }

    private function format_severity_counts(array $summary): string
    {
        $counts = $summary['issue_severity_counts'] ?? ($summary['severity_counts'] ?? null);
        if (!is_array($counts) || empty($counts)) {
            return '';
        }

        $parts = [];
        foreach ($counts as $severity => $count) {
            if (!is_numeric($count)) {
                continue;
            }
            $parts[] = sprintf('%s: %d', (string) $severity, (int) $count);
        }

        return implode(', ', $parts);
    }

    private function format_evidence_counts(array $summary): string
    {
        $evidence = isset($summary['evidence']) && is_array($summary['evidence']) ? $summary['evidence'] : [];
        if (empty($evidence)) {
            return '';
        }

        $screenshots = isset($evidence['screenshots_count']) && is_numeric($evidence['screenshots_count']) ? (int) $evidence['screenshots_count'] : 0;
        $lighthouseHtml = isset($evidence['lighthouse_html_count']) && is_numeric($evidence['lighthouse_html_count']) ? (int) $evidence['lighthouse_html_count'] : 0;

        return sprintf('screenshots: %d, lighthouse reports: %d', $screenshots, $lighthouseHtml);
    }

    private function render_status_pill(string $status): string
    {
        $value = sanitize_key($status);
        if ($value === '') {
            $value = 'unknown';
        }

        $class = 'baseline-status-pill status-' . sanitize_html_class($value);
        return '<span class="' . esc_attr($class) . '">' . esc_html($status !== '' ? $status : 'unknown') . '</span>';
    }

    private function format_scan_options_summary(array $options): string
    {
        $responsive = !empty($options['responsive_enabled']);
        $viewport = sanitize_key((string) ($options['viewport_preset'] ?? 'desktop'));
        if (!$responsive) {
            $viewportLabel = 'Desktop';
        } elseif ($viewport === 'mobile') {
            $viewportLabel = 'Mobile';
        } elseif ($viewport === 'both') {
            $viewportLabel = 'Desktop + Mobile';
        } else {
            $viewportLabel = 'Desktop';
        }

        $parts = [
            $viewportLabel,
            !empty($options['evidence_enabled']) ? 'Evidence' : 'No Evidence',
            !empty($options['lighthouse_enabled']) ? 'Lighthouse' : 'No Lighthouse',
            !empty($options['quick_scan_enabled']) ? 'Quick' : 'Standard'
        ];

        return implode(' + ', $parts);
    }

    private function format_scan_api_error(string $message): string
    {
        $normalized = strtolower(trim($message));
        if ($normalized === '') {
            return 'Scan request failed. Please retry.';
        }
        if (strpos($normalized, 'scan_limit_reached') !== false) {
            return 'Monthly scan limit reached for this site. Open Billing to upgrade plan limits or wait for period reset.';
        }
        if (strpos($normalized, 'hourly_scan_limit_exceeded') !== false) {
            return 'Hourly scan limit reached. Please wait up to 60 minutes, then retry.';
        }
        if (strpos($normalized, 'concurrent_scan_limit_exceeded') !== false) {
            return 'Another scan is already running. Wait for it to complete or stop it, then retry.';
        }
        if (strpos($normalized, 'unauthorized') !== false || strpos($normalized, 'forbidden') !== false) {
            return 'Authentication failed. Reconnect your site token in Baseline Settings and retry.';
        }
        if (strpos($normalized, 'callback_not_configured') !== false) {
            return 'Baseline callback is not configured in cloud settings. Configure callback secrets, then retry.';
        }
        return $message;
    }

    private function log_api_error(string $method, string $path, int $statusCode, string $message, ?array $payload = null, string $rawBody = ''): void
    {
        $context = [
            'method' => strtoupper($method),
            'path' => $path,
            'status' => $statusCode,
            'message' => $message,
        ];

        if (is_array($payload) && !empty($payload)) {
            $payloadJson = wp_json_encode($payload);
            if (is_string($payloadJson)) {
                $context['payload'] = substr($payloadJson, 0, 600);
            }
        }

        if ($rawBody !== '') {
            $context['raw_body'] = substr($rawBody, 0, 600);
        }

        error_log('[Baseline API] ' . wp_json_encode($context));
    }

    private function redirect_with_notice(string $page, string $status, string $message, string $scanId = ''): void
    {
        $url = add_query_arg(
            [
                'page' => $page,
                'baseline_notice' => $status,
                'baseline_message' => $message,
                'baseline_scan_id' => $scanId
            ],
            admin_url('admin.php')
        );
        wp_safe_redirect($url);
        exit;
    }

    private function redirect_to_post_with_notice(int $postId, string $status, string $message, string $scanId = ''): void
    {
        $url = add_query_arg(
            [
                'post' => $postId,
                'action' => 'edit',
                'baseline_notice' => $status,
                'baseline_message' => $message,
                'baseline_scan_id' => $scanId
            ],
            admin_url('post.php')
        );

        wp_safe_redirect($url);
        exit;
    }
}

<?php

if (!defined('ABSPATH')) {
    exit;
}

class WPLG_Admin
{
    private const OPTION_API_BASE = 'wplg_api_base_url';
    private const OPTION_SITE_TOKEN = 'wplg_site_token';
    private const OPTION_SITE_ID = 'wplg_site_id';
    private const OPTION_TENANT_ID = 'wplg_tenant_id';
    private const OPTION_LAST_SCAN_ID = 'wplg_last_scan_id';
    private const OPTION_DEFAULT_FORM_MODE = 'wplg_default_form_mode';
    private const OPTION_SCAN_DEFAULTS = 'wplg_scan_defaults';

    private const META_SCAN_OPTIONS = '_wplg_scan_options';
    private const META_SCAN_USE_SITE_DEFAULTS = '_wplg_scan_use_site_defaults';
    private const META_LAST_SCAN_ID = '_wplg_last_scan_id';

    public function __construct()
    {
        add_action('admin_menu', [$this, 'register_menu']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_assets']);

        add_action('admin_post_wplg_register_site', [$this, 'handle_register_site']);
        add_action('admin_post_wplg_run_scan', [$this, 'handle_run_scan']);
        add_action('admin_post_wplg_run_page_scan', [$this, 'handle_run_page_scan']);
        add_action('admin_post_wplg_save_branding', [$this, 'handle_save_branding']);
        add_action('admin_post_wplg_start_checkout', [$this, 'handle_start_checkout']);

        add_action('add_meta_boxes', [$this, 'register_scan_metaboxes']);
        add_action('save_post', [$this, 'handle_save_scan_metabox'], 10, 2);

        add_action('admin_notices', [$this, 'render_admin_notice']);
    }

    public function register_menu(): void
    {
        add_menu_page(
            __('WP LaunchGuard', 'wplaunchguard'),
            __('LaunchGuard', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-dashboard',
            [$this, 'render_dashboard'],
            'dashicons-shield-alt',
            65
        );

        add_submenu_page(
            'wplaunchguard-dashboard',
            __('Branding', 'wplaunchguard'),
            __('Branding', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-branding',
            [$this, 'render_branding']
        );

        add_submenu_page(
            'wplaunchguard-dashboard',
            __('Billing', 'wplaunchguard'),
            __('Billing', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-billing',
            [$this, 'render_billing']
        );

        add_submenu_page(
            'wplaunchguard-dashboard',
            __('Settings', 'wplaunchguard'),
            __('Settings', 'wplaunchguard'),
            'manage_options',
            'wplaunchguard-settings',
            [$this, 'render_settings']
        );
    }

    public function register_settings(): void
    {
        register_setting('wplg_settings_group', self::OPTION_API_BASE, [
            'type' => 'string',
            'sanitize_callback' => 'esc_url_raw',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_SITE_TOKEN, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_SITE_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_TENANT_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_LAST_SCAN_ID, [
            'type' => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default' => ''
        ]);

        register_setting('wplg_settings_group', self::OPTION_DEFAULT_FORM_MODE, [
            'type' => 'string',
            'sanitize_callback' => [$this, 'sanitize_form_mode'],
            'default' => 'dry-run'
        ]);

        register_setting('wplg_settings_group', self::OPTION_SCAN_DEFAULTS, [
            'type' => 'array',
            'sanitize_callback' => [$this, 'sanitize_scan_defaults_option'],
            'default' => $this->default_scan_options()
        ]);
    }

    public function sanitize_form_mode(string $value): string
    {
        return in_array($value, ['dry-run', 'live'], true) ? $value : 'dry-run';
    }

    public function sanitize_scan_defaults_option($value): array
    {
        return $this->sanitize_scan_options($value, $this->default_scan_options());
    }

    public function enqueue_assets(string $hook): void
    {
        $needsAssets = strpos($hook, 'wplaunchguard') !== false || in_array($hook, ['post.php', 'post-new.php'], true);
        if (!$needsAssets) {
            return;
        }
        wp_enqueue_style('wplg-admin', WPLG_PLUGIN_URL . 'assets/css/admin.css', [], WPLG_VERSION);
    }

    public function register_scan_metaboxes(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }

        foreach ($this->get_supported_scan_post_types() as $postType) {
            add_meta_box(
                'wplg-page-scan',
                __('LaunchGuard Page Scan', 'wplaunchguard'),
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
        $submitModeInputId = 'wplg_scan_submit_mode_' . (int) $post->ID;

        wp_nonce_field('wplg_page_scan_settings', 'wplg_page_scan_settings_nonce');
        wp_nonce_field('wplg_run_page_scan', 'wplg_run_page_scan_nonce');

        echo '<input type="hidden" name="wplg_post_id" value="' . esc_attr((string) $post->ID) . '" />';
        echo '<input type="hidden" id="' . esc_attr($submitModeInputId) . '" name="wplg_scan_submit_mode" value="custom" />';

        echo '<p><strong>Target URL</strong><br />';
        echo '<input class="widefat" type="text" readonly value="' . esc_attr($targetUrl !== '' ? $targetUrl : 'Publish this content to generate a public URL.') . '" /></p>';

        echo '<p><strong>Form Mode</strong><br />';
        echo '<select class="widefat" name="wplg_page_form_mode">';
        echo '<option value="dry-run"' . selected($formMode, 'dry-run', false) . '>dry-run</option>';
        echo '<option value="live"' . selected($formMode, 'live', false) . '>live</option>';
        echo '</select></p>';

        echo '<div class="wplg-metabox-options">';
        echo '<input type="hidden" name="wplg_scan_use_site_defaults" value="0" />';
        echo '<label class="wplg-toggle-row">';
        echo '<input type="checkbox" name="wplg_scan_use_site_defaults" value="1" ' . checked($useSiteDefaults, true, false) . ' />';
        echo '<span><strong>Use Site Defaults</strong></span>';
        echo '</label>';
        echo '<p class="description">Use your global scan profile from LaunchGuard Dashboard.</p>';

        $this->render_scan_option_rows($effectiveOptions, 'wplg_scan_options');
        echo '</div>';

        $actionUrl = esc_url(admin_url('admin-post.php'));
        $disabled = $isPublished ? '' : ' disabled="disabled"';

        echo '<p class="wplg-metabox-actions">';
        echo '<button type="submit" class="button button-primary" formmethod="post" formaction="' . $actionUrl . '" name="action" value="wplg_run_page_scan" onclick="document.getElementById(\'' . esc_attr($submitModeInputId) . '\').value=\'custom\';"' . $disabled . '>Scan This Page</button> ';
        echo '<button type="submit" class="button" formmethod="post" formaction="' . $actionUrl . '" name="action" value="wplg_run_page_scan" onclick="document.getElementById(\'' . esc_attr($submitModeInputId) . '\').value=\'defaults\';"' . $disabled . '>Use Site Defaults</button>';
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

        if (!isset($_POST['wplg_page_scan_settings_nonce'])) {
            return;
        }

        $nonce = sanitize_text_field((string) wp_unslash($_POST['wplg_page_scan_settings_nonce']));
        if (!wp_verify_nonce($nonce, 'wplg_page_scan_settings')) {
            return;
        }

        if (!current_user_can('edit_post', $postId)) {
            return;
        }

        if (!in_array($post->post_type, $this->get_supported_scan_post_types(), true)) {
            return;
        }

        $defaults = $this->get_scan_defaults();
        $rawOptions = wp_unslash($_POST['wplg_scan_options'] ?? []);
        $scanOptions = $this->sanitize_scan_options($rawOptions, $defaults);
        $useSiteDefaults = !empty($_POST['wplg_scan_use_site_defaults']);

        update_post_meta($postId, self::META_SCAN_OPTIONS, $scanOptions);
        update_post_meta($postId, self::META_SCAN_USE_SITE_DEFAULTS, $useSiteDefaults ? '1' : '0');
    }

    public function render_admin_notice(): void
    {
        if (!is_admin()) {
            return;
        }

        if (!isset($_GET['wplg_notice']) || !isset($_GET['wplg_message'])) {
            return;
        }

        $noticeType = sanitize_key((string) wp_unslash($_GET['wplg_notice']));
        $message = sanitize_text_field((string) wp_unslash($_GET['wplg_message']));
        $class = $noticeType === 'success' ? 'notice notice-success' : 'notice notice-error';

        echo '<div class="' . esc_attr($class) . ' is-dismissible"><p>' . esc_html($message);

        if (!empty($_GET['wplg_scan_id'])) {
            $scanId = sanitize_text_field((string) wp_unslash($_GET['wplg_scan_id']));
            $dashboardUrl = add_query_arg(['page' => 'wplaunchguard-dashboard'], admin_url('admin.php'));
            echo ' <a href="' . esc_url($dashboardUrl) . '">View latest scan</a> (' . esc_html($scanId) . ')';
        }

        echo '</p></div>';
    }

    public function render_dashboard(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);
        $connected = $siteId !== '';
        $autoRefreshActive = false;
        $siteHost = wp_parse_url(home_url('/'), PHP_URL_HOST);

        echo '<div class="wrap wplg-wrap wplg-dashboard">';
        echo '<div class="wplg-page-header">';
        echo '<div class="wplg-page-title">';
        echo '<h1>WP LaunchGuard</h1>';
        echo '<p class="wplg-page-subtitle">Cloud QA control center for scans, evidence, and client-ready reporting.</p>';
        echo '</div>';
        echo '<div class="wplg-page-meta">';
        echo '<span class="wplg-badge ' . ($connected ? 'is-success' : 'is-warning') . '">' . ($connected ? 'Connected' : 'Not Connected') . '</span>';
        if (!empty($siteHost)) {
            echo '<span class="wplg-badge">' . esc_html((string) $siteHost) . '</span>';
        }
        echo '</div>';
        echo '</div>';

        if (!$connected) {
            echo '<div class="wplg-card wplg-card-hero">';
            echo '<h2>Connect This Site</h2>';
            echo '<p>Register this WordPress site with your LaunchGuard API to enable scans and white-label controls.</p>';
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="wplg_register_site" />';
            wp_nonce_field('wplg_register_site');
            submit_button('Register Site');
            echo '</form>';
            echo '</div>';
            echo '</div>';
            return;
        }

        $limits = $this->fetch_limits($siteId);
        $scans = $this->fetch_scans($siteId, 10);
        $lastScan = $this->fetch_last_scan();
        $scanDefaults = $this->get_scan_defaults();

        echo '<div class="wplg-grid wplg-grid-top">';

        echo '<div class="wplg-card wplg-card-connection">';
        echo '<h2>Connection</h2>';
        echo '<ul class="wplg-kv-list">';
        echo '<li><span>Site ID</span><code>' . esc_html($siteId) . '</code></li>';
        echo '<li><span>Tenant ID</span><code>' . esc_html($this->get_option(self::OPTION_TENANT_ID)) . '</code></li>';
        echo '<li><span>API Base</span><code>' . esc_html($this->get_api_base()) . '</code></li>';
        echo '</ul>';
        echo '</div>';

        echo '<div class="wplg-card wplg-card-scan-setup">';
        echo '<h2>Scan Setup</h2>';
        echo '<p class="wplg-card-intro">Choose the scan profile for this run. You can still override per-page scans from post/page edit screens.</p>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" class="wplg-scan-config-form">';
        echo '<input type="hidden" name="action" value="wplg_run_scan" />';
        wp_nonce_field('wplg_run_scan');

        echo '<div class="wplg-scan-section">';
        echo '<h3>Scope</h3>';
        echo '<p><label for="wplg_form_mode"><strong>Form Mode</strong></label><br />';
        echo '<select id="wplg_form_mode" name="form_mode">';
        $defaultMode = $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run');
        echo '<option value="dry-run"' . selected($defaultMode, 'dry-run', false) . '>dry-run</option>';
        echo '<option value="live"' . selected($defaultMode, 'live', false) . '>live</option>';
        echo '</select></p>';
        echo '<p><label for="wplg_sitemap_url"><strong>Sitemap URL (optional)</strong></label><br />';
        echo '<input class="regular-text" type="url" id="wplg_sitemap_url" name="sitemap_url" placeholder="https://example.com/sitemap_index.xml" /></p>';
        echo '</div>';

        echo '<div class="wplg-scan-section">';
        echo '<h3>Performance/Coverage</h3>';
        $this->render_toggle_field('scan_options[quick_scan_enabled]', 'wplg_quick_scan', !empty($scanDefaults['quick_scan_enabled']), 'Quick scan', 'Runs a faster reduced project set for quicker feedback (example: ~2–4 min vs full run).');
        $this->render_toggle_field('scan_options[responsive_enabled]', 'wplg_responsive_scan', !empty($scanDefaults['responsive_enabled']), 'Responsive scan', 'Tests mobile/tablet layouts for breakpoint issues (example: overlapping buttons on 390px width).');

        $viewportVisibleClass = !empty($scanDefaults['responsive_enabled']) ? '' : ' is-hidden';
        echo '<div class="wplg-field' . esc_attr($viewportVisibleClass) . '" data-wplg-viewport-wrap="dashboard">';
        echo '<label for="wplg_viewport_preset"><strong>Viewport preset</strong></label>' . $this->render_help_tip('Choose which device classes to test: Desktop, Mobile, or Both.') . '<br />';
        echo '<select id="wplg_viewport_preset" name="scan_options[viewport_preset]" data-wplg-viewport-select="dashboard">';
        echo '<option value="desktop"' . selected($scanDefaults['viewport_preset'], 'desktop', false) . '>Desktop</option>';
        echo '<option value="mobile"' . selected($scanDefaults['viewport_preset'], 'mobile', false) . '>Mobile</option>';
        echo '<option value="both"' . selected($scanDefaults['viewport_preset'], 'both', false) . '>Both</option>';
        echo '</select>';
        echo '</div>';
        echo '</div>';

        echo '<div class="wplg-scan-section">';
        echo '<h3>Evidence</h3>';
        $this->render_toggle_field('scan_options[evidence_enabled]', 'wplg_evidence_enabled', !empty($scanDefaults['evidence_enabled']), 'Evidence', 'Captures screenshot proof for detected issues (example: missing alt text evidence).');
        $this->render_toggle_field('scan_options[lighthouse_enabled]', 'wplg_lighthouse_enabled', !empty($scanDefaults['lighthouse_enabled']), 'Lighthouse', 'Runs Lighthouse audits for performance/SEO/accessibility metrics (example: LCP, CLS, SEO score).');
        echo '</div>';

        echo '<p class="wplg-summary-line"><strong>Selected profile summary:</strong> <span id="wplg-dashboard-summary-text"></span></p>';

        submit_button('Start Scan', 'primary wplg-primary-cta', 'submit', false);
        echo '</form>';
        echo '</div>';

        echo '</div>';

        echo '<div class="wplg-grid wplg-grid-mid">';
        echo '<div class="wplg-card wplg-card-plan">';
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

            echo '<ul class="wplg-kv-list">';
            echo '<li><span>Period</span><strong>' . esc_html((string) ($data['period_key'] ?? 'n/a')) . '</strong></li>';
            echo '<li><span>Plan</span><strong>' . esc_html($planId) . ' <span class="wplg-inline-muted">(' . esc_html($billingStatus) . ')</span></strong></li>';
            echo '<li><span>Scans</span><strong>' . esc_html((string) $scansUsed) . ' / ' . esc_html((string) $scansLimit) . '</strong></li>';
            echo '<li><span>Sites Limit</span><strong>' . esc_html((string) ($data['sites_limit'] ?? 0)) . '</strong></li>';
            echo '</ul>';
            echo '<div class="wplg-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' . esc_attr((string) $usagePercent) . '">';
            echo '<span style="width:' . esc_attr((string) $usagePercent) . '%"></span>';
            echo '</div>';
            echo '<div class="wplg-actions"><a class="button" href="' . esc_url(admin_url('admin.php?page=wplaunchguard-billing')) . '">Manage Billing</a></div>';
        }
        echo '</div>';

        echo '<div class="wplg-card wplg-card-latest">';
        echo '<h2>Latest Scan</h2>';
        if (is_wp_error($lastScan)) {
            echo '<p>' . esc_html($lastScan->get_error_message()) . '</p>';
        } elseif (!$lastScan) {
            echo '<p>No scans started yet.</p>';
        } else {
            $scan = $lastScan['data']['scan'] ?? [];
            $scanSummary = $this->extract_scan_summary($scan);
            $scanStatus = sanitize_key((string) ($scan['status'] ?? ''));
            echo '<ul class="wplg-kv-list">';
            echo '<li><span>ID</span><code>' . esc_html((string) ($scan['id'] ?? 'n/a')) . '</code></li>';
            echo '<li><span>Status</span>' . $this->render_status_pill((string) ($scan['status'] ?? 'n/a')) . '</li>';
            echo '<li><span>Created</span><strong>' . esc_html((string) ($scan['created_at'] ?? 'n/a')) . '</strong></li>';
            echo '<li><span>Completed</span><strong>' . esc_html((string) ($scan['completed_at'] ?? 'pending')) . '</strong></li>';

            $targetUrl = sanitize_text_field((string) ($scan['target_url'] ?? ($scanSummary['target_url'] ?? '')));
            if ($targetUrl !== '') {
                echo '<li><span>Target URL</span><span class="wplg-break-word"><code>' . esc_html($targetUrl) . '</code></span></li>';
            }

            $scanOptions = $this->extract_scan_options($scan, $scanSummary);
            if (!empty($scanOptions)) {
                echo '<li><span>Profile</span><strong>' . esc_html($this->format_scan_options_summary($scanOptions)) . '</strong></li>';
            }
            echo '</ul>';

            $progressPercent = $this->estimate_scan_progress($scanStatus, $scanSummary);
            echo '<p><strong>Progress:</strong> ' . esc_html((string) $progressPercent) . '%</p>';
            echo '<div class="wplg-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' . esc_attr((string) $progressPercent) . '">';
            echo '<span style="width:' . esc_attr((string) $progressPercent) . '%"></span>';
            echo '</div>';

            $etaText = $this->get_scan_eta_text($scanStatus);
            if ($etaText !== '') {
                echo '<p class="description">' . esc_html($etaText) . '</p>';
            }

            if ($this->is_scan_in_progress($scanStatus)) {
                $autoRefreshActive = true;
                echo '<p class="description">This page auto-refreshes every 15 seconds while your scan is running.</p>';
                echo '<div class="wplg-actions"><a class="button" href="' . esc_url(admin_url('admin.php?page=wplaunchguard-dashboard')) . '">Refresh Now</a></div>';
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

            echo '<div class="wplg-actions">';
            if (!empty($scanSummary['report_index_url'])) {
                echo '<a class="button button-primary" target="_blank" rel="noopener" href="' . esc_url((string) $scanSummary['report_index_url']) . '">View Report</a>';
            }

            if (!empty($scanSummary['workflow_url'])) {
                echo '<a class="button" target="_blank" rel="noopener" href="' . esc_url((string) $scanSummary['workflow_url']) . '">Open GitHub Run</a>';
            }

            if (!empty($scanSummary['reports_artifact_url'])) {
                echo '<a class="button" target="_blank" rel="noopener" href="' . esc_url((string) $scanSummary['reports_artifact_url']) . '">Download Report ZIP</a>';
            }
            echo '</div>';

            $evidenceText = $this->format_evidence_counts($scanSummary);
            if ($evidenceText !== '') {
                echo '<p><strong>Evidence:</strong> ' . esc_html($evidenceText) . '</p>';
            }
        }
        echo '</div>';
        echo '</div>';

        echo '<div class="wplg-card wplg-card-recent">';
        echo '<h2>Recent Scans</h2>';
        if (is_wp_error($scans)) {
            echo '<p>' . esc_html($scans->get_error_message()) . '</p>';
        } else {
            $rows = $scans['data']['scans'] ?? [];
            if (empty($rows)) {
                echo '<p>No scan history yet.</p>';
            } else {
                echo '<div class="wplg-table-wrap">';
                echo '<table class="widefat striped wplg-table">';
                echo '<thead><tr><th>Scan ID</th><th>Status</th><th>Mode</th><th>Issues</th><th>Report</th><th>Created</th></tr></thead><tbody>';
                foreach ($rows as $row) {
                    $rowSummary = $this->extract_scan_summary($row);
                    $rowIssues = $this->extract_issues_total($rowSummary);
                    $reportUrl = (string) ($rowSummary['report_index_url'] ?? ($rowSummary['workflow_url'] ?? ($rowSummary['reports_artifact_url'] ?? '')));
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
            }
        }
        echo '</div>';

        if ($autoRefreshActive) {
            echo '<script>setTimeout(function(){ window.location.reload(); }, 15000);</script>';
        }

        $this->render_scan_form_script();
        echo '</div>';
    }

    public function render_branding(): void
    {
        $siteId = $this->get_option(self::OPTION_SITE_ID);

        echo '<div class="wrap wplg-wrap">';
        echo '<h1>Branding</h1>';

        if ($siteId === '') {
            echo '<p>Connect your site in LaunchGuard Dashboard first.</p>';
            echo '</div>';
            return;
        }

        $brandingData = [
            'brand_name' => '',
            'logo_url' => '',
            'primary_color' => '#1f2937',
            'accent_color' => '#22c55e',
            'footer_text' => '',
            'hide_launchguard_branding' => 0
        ];

        $response = $this->api_request('GET', '/v1/sites/' . rawurlencode($siteId) . '/branding');
        if (!is_wp_error($response) && isset($response['data']['branding']) && is_array($response['data']['branding'])) {
            $brandingData = array_merge($brandingData, $response['data']['branding']);
        }

        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        echo '<input type="hidden" name="action" value="wplg_save_branding" />';
        wp_nonce_field('wplg_save_branding');

        echo '<table class="form-table" role="presentation">';
        echo '<tr><th scope="row"><label for="wplg_brand_name">Brand Name</label></th><td><input class="regular-text" type="text" id="wplg_brand_name" name="brand_name" value="' . esc_attr((string) $brandingData['brand_name']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_logo_url">Logo URL</label></th><td><input class="regular-text" type="url" id="wplg_logo_url" name="logo_url" value="' . esc_attr((string) $brandingData['logo_url']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_primary_color">Primary Color</label></th><td><input type="color" id="wplg_primary_color" name="primary_color" value="' . esc_attr((string) $brandingData['primary_color']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_accent_color">Accent Color</label></th><td><input type="color" id="wplg_accent_color" name="accent_color" value="' . esc_attr((string) $brandingData['accent_color']) . '" /></td></tr>';
        echo '<tr><th scope="row"><label for="wplg_footer_text">Footer Text</label></th><td><textarea class="large-text" rows="3" id="wplg_footer_text" name="footer_text">' . esc_textarea((string) $brandingData['footer_text']) . '</textarea></td></tr>';

        $checked = !empty($brandingData['hide_launchguard_branding']) ? 'checked' : '';
        echo '<tr><th scope="row">White-label Mode</th><td><label><input type="checkbox" name="hide_launchguard_branding" value="1" ' . esc_attr($checked) . ' /> Hide LaunchGuard branding in exported reports</label></td></tr>';
        echo '</table>';

        submit_button('Save Branding');
        echo '</form>';
        echo '</div>';
    }

    public function render_settings(): void
    {
        ?>
        <div class="wrap wplg-wrap">
            <h1>Settings</h1>
            <form method="post" action="options.php">
                <?php settings_fields('wplg_settings_group'); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="wplg_api_base_url">API Base URL</label></th>
                        <td><input class="regular-text" type="url" id="wplg_api_base_url" name="wplg_api_base_url" value="<?php echo esc_attr($this->get_option(self::OPTION_API_BASE)); ?>" placeholder="https://launchguard-api.your-subdomain.workers.dev" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_site_token">Site Token</label></th>
                        <td><input class="regular-text" type="text" id="wplg_site_token" name="wplg_site_token" value="<?php echo esc_attr($this->get_option(self::OPTION_SITE_TOKEN)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_site_id">Site ID</label></th>
                        <td><input class="regular-text" type="text" id="wplg_site_id" name="wplg_site_id" value="<?php echo esc_attr($this->get_option(self::OPTION_SITE_ID)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_tenant_id">Tenant ID</label></th>
                        <td><input class="regular-text" type="text" id="wplg_tenant_id" name="wplg_tenant_id" value="<?php echo esc_attr($this->get_option(self::OPTION_TENANT_ID)); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="wplg_default_form_mode">Default Form Mode</label></th>
                        <td>
                            <select id="wplg_default_form_mode" name="wplg_default_form_mode">
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

        echo '<div class="wrap wplg-wrap">';
        echo '<h1>Billing</h1>';

        if ($siteId === '') {
            echo '<p>Connect your site in LaunchGuard Dashboard first.</p>';
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

        echo '<div class="wplg-card">';
        echo '<h2>Current Subscription</h2>';
        echo '<p><strong>Plan:</strong> ' . esc_html($currentPlanId) . '</p>';
        echo '<p><strong>Status:</strong> ' . esc_html($billingStatus) . '</p>';
        if ($currentPeriodEnd !== '') {
            echo '<p><strong>Current Period End:</strong> ' . esc_html($currentPeriodEnd) . '</p>';
        }
        echo '</div>';

        if (empty($plans)) {
            echo '<div class="wplg-card"><p>No plans available yet.</p></div>';
            echo '</div>';
            return;
        }

        echo '<div class="wplg-plan-grid">';
        foreach ($plans as $plan) {
            $planId = sanitize_text_field((string) ($plan['id'] ?? ''));
            $planScans = (int) ($plan['scans_limit'] ?? 0);
            $planSites = (int) ($plan['sites_limit'] ?? 0);
            $planWhitelabel = !empty($plan['whitelabel']);
            $stripeConfigured = !empty($plan['stripe_price_configured']);
            $isCurrent = $planId === $currentPlanId;

            echo '<div class="wplg-card wplg-plan-card">';
            echo '<h2>' . esc_html(ucfirst($planId)) . '</h2>';
            if ($isCurrent) {
                echo '<p><span class="wplg-pill">Current</span></p>';
            }
            echo '<p><strong>Scans / month:</strong> ' . esc_html((string) $planScans) . '</p>';
            echo '<p><strong>Sites:</strong> ' . esc_html((string) $planSites) . '</p>';
            echo '<p><strong>White-label:</strong> ' . esc_html($planWhitelabel ? 'Included' : 'No') . '</p>';

            if (!$stripeConfigured) {
                echo '<p>Checkout not configured for this plan yet.</p>';
            }

            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
            echo '<input type="hidden" name="action" value="wplg_start_checkout" />';
            echo '<input type="hidden" name="plan_id" value="' . esc_attr($planId) . '" />';
            wp_nonce_field('wplg_start_checkout');

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
        $this->ensure_admin_post('wplg_register_site');

        $payload = [
            'site_url' => home_url('/'),
            'tenant_id' => 'tenant-' . substr(md5(home_url('/')), 0, 12),
            'tenant_name' => get_bloginfo('name'),
            'plan_id' => 'starter',
            'wp_version' => get_bloginfo('version'),
            'php_version' => PHP_VERSION,
            'plugin_version' => WPLG_VERSION,
            'timezone' => wp_timezone_string() ?: 'UTC'
        ];

        $response = $this->api_request('POST', '/v1/sites/register', $payload, false);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', $response->get_error_message());
        }

        $data = $response['data'];
        if (empty($data['site_id']) || empty($data['site_token'])) {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', 'Site registration response missing required fields.');
        }

        update_option(self::OPTION_SITE_ID, sanitize_text_field((string) $data['site_id']));
        update_option(self::OPTION_SITE_TOKEN, sanitize_text_field((string) $data['site_token']));
        update_option(self::OPTION_TENANT_ID, sanitize_text_field((string) ($data['tenant_id'] ?? '')));

        $this->redirect_with_notice('wplaunchguard-dashboard', 'success', 'Site registered successfully.');
    }

    public function handle_run_scan(): void
    {
        $this->ensure_admin_post('wplg_run_scan');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', 'Connect the site before running scans.');
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
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', $response->get_error_message());
        }

        $scanId = sanitize_text_field((string) ($response['data']['scan_id'] ?? ''));
        if ($scanId !== '') {
            update_option(self::OPTION_LAST_SCAN_ID, $scanId);
        }

        $this->redirect_with_notice('wplaunchguard-dashboard', 'success', 'Scan queued successfully.');
    }

    public function handle_run_page_scan(): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized request');
        }

        check_admin_referer('wplg_run_page_scan', 'wplg_run_page_scan_nonce');

        $postId = absint(wp_unslash($_POST['wplg_post_id'] ?? ($_POST['post_ID'] ?? 0)));
        if ($postId <= 0) {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', 'Invalid post target for page scan.');
        }

        $post = get_post($postId);
        if (!$post instanceof WP_Post) {
            $this->redirect_with_notice('wplaunchguard-dashboard', 'error', 'Unable to load post for page scan.');
        }

        if (!in_array($post->post_type, $this->get_supported_scan_post_types(), true)) {
            $this->redirect_to_post_with_notice($postId, 'error', 'This post type is not eligible for LaunchGuard page scans.');
        }

        $targetUrl = $this->get_published_target_url($postId);
        if ($targetUrl === '') {
            $this->redirect_to_post_with_notice($postId, 'error', 'Publish this page to generate a public URL before scanning.');
        }

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_to_post_with_notice($postId, 'error', 'Connect the site before running scans.');
        }

        $formMode = $this->sanitize_form_mode(sanitize_text_field((string) wp_unslash($_POST['wplg_page_form_mode'] ?? $this->get_option(self::OPTION_DEFAULT_FORM_MODE, 'dry-run'))));
        update_option(self::OPTION_DEFAULT_FORM_MODE, $formMode);

        $defaults = $this->get_scan_defaults();
        $storedPostOptions = $this->sanitize_scan_options(wp_unslash($_POST['wplg_scan_options'] ?? []), $defaults);
        $submitMode = sanitize_key((string) wp_unslash($_POST['wplg_scan_submit_mode'] ?? 'custom'));
        $useSiteDefaults = $submitMode === 'defaults' || !empty($_POST['wplg_scan_use_site_defaults']);
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
            $this->redirect_to_post_with_notice($postId, 'error', $response->get_error_message());
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
        $this->ensure_admin_post('wplg_save_branding');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('wplaunchguard-branding', 'error', 'Connect the site before saving branding.');
        }

        $payload = [
            'brand_name' => sanitize_text_field((string) ($_POST['brand_name'] ?? '')),
            'logo_url' => esc_url_raw((string) ($_POST['logo_url'] ?? '')),
            'primary_color' => sanitize_hex_color((string) ($_POST['primary_color'] ?? '')) ?: '#1f2937',
            'accent_color' => sanitize_hex_color((string) ($_POST['accent_color'] ?? '')) ?: '#22c55e',
            'footer_text' => sanitize_textarea_field((string) ($_POST['footer_text'] ?? '')),
            'hide_launchguard_branding' => !empty($_POST['hide_launchguard_branding'])
        ];

        $response = $this->api_request('PUT', '/v1/sites/' . rawurlencode($siteId) . '/branding', $payload);
        if (is_wp_error($response)) {
            $this->redirect_with_notice('wplaunchguard-branding', 'error', $response->get_error_message());
        }

        $this->redirect_with_notice('wplaunchguard-branding', 'success', 'Branding saved.');
    }

    public function handle_start_checkout(): void
    {
        $this->ensure_admin_post('wplg_start_checkout');

        $siteId = $this->get_option(self::OPTION_SITE_ID);
        if ($siteId === '') {
            $this->redirect_with_notice('wplaunchguard-billing', 'error', 'Connect the site before starting checkout.');
        }

        $planId = sanitize_key((string) ($_POST['plan_id'] ?? ''));
        if (!in_array($planId, ['starter', 'growth', 'agency'], true)) {
            $this->redirect_with_notice('wplaunchguard-billing', 'error', 'Invalid plan selected.');
        }

        $successUrl = add_query_arg(
            [
                'page' => 'wplaunchguard-billing',
                'wplg_notice' => 'success',
                'wplg_message' => 'Checkout complete. Billing status may take up to 60 seconds to refresh.'
            ],
            admin_url('admin.php')
        );

        $cancelUrl = add_query_arg(
            [
                'page' => 'wplaunchguard-billing',
                'wplg_notice' => 'error',
                'wplg_message' => 'Checkout canceled.'
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
            $this->redirect_with_notice('wplaunchguard-billing', 'error', $response->get_error_message());
        }

        $checkoutUrl = esc_url_raw((string) ($response['data']['checkout_url'] ?? ''));
        if ($checkoutUrl === '' || !preg_match('#^https://#', $checkoutUrl)) {
            $this->redirect_with_notice('wplaunchguard-billing', 'error', 'Checkout URL missing from API response.');
        }

        wp_redirect($checkoutUrl);
        exit;
    }

    private function ensure_admin_post(string $action): void
    {
        if (!current_user_can('manage_options')) {
            wp_die('Unauthorized request');
        }
        check_admin_referer($action);
    }

    private function get_api_base(): string
    {
        return untrailingslashit($this->get_option(self::OPTION_API_BASE));
    }

    private function get_option(string $key, string $default = ''): string
    {
        $value = get_option($key, $default);
        return is_string($value) ? $value : $default;
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

        echo '<p><strong>ID:</strong> ' . esc_html($scanId) . '</p>';
        echo '<p><strong>Status:</strong> ' . esc_html((string) ($scan['status'] ?? 'unknown')) . '</p>';

        if (!empty($summary['report_index_url'])) {
            echo '<p><a class="button button-primary" target="_blank" rel="noopener" href="' . esc_url((string) $summary['report_index_url']) . '">View Report</a></p>';
            return;
        }

        if (!empty($summary['workflow_url'])) {
            echo '<p><a class="button" target="_blank" rel="noopener" href="' . esc_url((string) $summary['workflow_url']) . '">Open GitHub Run</a></p>';
        }
    }

    private function render_toggle_field(string $name, string $id, bool $checkedValue, string $label, string $tooltip): void
    {
        echo '<div class="wplg-field">';
        echo '<input type="hidden" name="' . esc_attr($name) . '" value="0" />';
        echo '<label class="wplg-toggle-row" for="' . esc_attr($id) . '">';
        echo '<input type="checkbox" id="' . esc_attr($id) . '" name="' . esc_attr($name) . '" value="1" ' . checked($checkedValue, true, false) . ' />';
        echo '<span><strong>' . esc_html($label) . '</strong></span>';
        echo '</label>';
        echo $this->render_help_tip($tooltip);
        echo '</div>';
    }

    private function render_scan_option_rows(array $options, string $namePrefix): void
    {
        $this->render_toggle_field($namePrefix . '[evidence_enabled]', $namePrefix . '_evidence_enabled', !empty($options['evidence_enabled']), 'Evidence', 'Captures screenshot proof for detected issues (example: missing alt text evidence).');
        $this->render_toggle_field($namePrefix . '[lighthouse_enabled]', $namePrefix . '_lighthouse_enabled', !empty($options['lighthouse_enabled']), 'Lighthouse', 'Runs Lighthouse audits for performance/SEO/accessibility metrics (example: LCP, CLS, SEO score).');
        $this->render_toggle_field($namePrefix . '[quick_scan_enabled]', $namePrefix . '_quick_scan_enabled', !empty($options['quick_scan_enabled']), 'Quick scan', 'Runs a faster reduced project set for quicker feedback (example: ~2–4 min vs full run).');
        $this->render_toggle_field($namePrefix . '[responsive_enabled]', $namePrefix . '_responsive_enabled', !empty($options['responsive_enabled']), 'Responsive scan', 'Tests mobile/tablet layouts for breakpoint issues (example: overlapping buttons on 390px width).');

        $wrapperClass = !empty($options['responsive_enabled']) ? 'wplg-field' : 'wplg-field is-hidden';
        echo '<div class="' . esc_attr($wrapperClass) . '" data-wplg-viewport-wrap="' . esc_attr($namePrefix) . '">';
        echo '<label for="' . esc_attr($namePrefix . '_viewport_preset') . '"><strong>Viewport preset</strong></label>' . $this->render_help_tip('Choose which device classes to test: Desktop, Mobile, or Both.') . '<br />';
        echo '<select class="widefat" id="' . esc_attr($namePrefix . '_viewport_preset') . '" name="' . esc_attr($namePrefix . '[viewport_preset]') . '" data-wplg-viewport-select="' . esc_attr($namePrefix) . '">';
        echo '<option value="desktop"' . selected($options['viewport_preset'], 'desktop', false) . '>Desktop</option>';
        echo '<option value="mobile"' . selected($options['viewport_preset'], 'mobile', false) . '>Mobile</option>';
        echo '<option value="both"' . selected($options['viewport_preset'], 'both', false) . '>Both</option>';
        echo '</select>';
        echo '</div>';
    }

    private function render_help_tip(string $text): string
    {
        return ' <span class="dashicons dashicons-editor-help wplg-help-tip" title="' . esc_attr($text) . '" aria-label="' . esc_attr($text) . '"></span>';
    }

    private function render_scan_form_script(): void
    {
        ?>
        <script>
          (function() {
            function updateDashboardSummary() {
              var root = document.querySelector('.wplg-scan-config-form');
              if (!root) return;

              var quick = root.querySelector('input[name="scan_options[quick_scan_enabled]"]:checked');
              var responsive = root.querySelector('input[name="scan_options[responsive_enabled]"]:checked');
              var evidence = root.querySelector('input[name="scan_options[evidence_enabled]"]:checked');
              var lighthouse = root.querySelector('input[name="scan_options[lighthouse_enabled]"]:checked');
              var viewport = root.querySelector('select[name="scan_options[viewport_preset]"]');
              var summary = document.getElementById('wplg-dashboard-summary-text');

              var viewportValue = 'Desktop';
              if (responsive && viewport) {
                if (viewport.value === 'mobile') viewportValue = 'Mobile';
                if (viewport.value === 'both') viewportValue = 'Desktop + Mobile';
              }

              var parts = [];
              parts.push(viewportValue);
              parts.push(evidence ? 'Evidence' : 'No Evidence');
              parts.push(lighthouse ? 'Lighthouse' : 'No Lighthouse');
              parts.push(quick ? 'Quick' : 'Standard');

              if (summary) {
                summary.textContent = parts.join(' + ');
              }
            }

            function bindViewportToggle(namePrefix) {
              var responsive = document.getElementById(namePrefix + '_responsive_enabled');
              var viewportWrap = document.querySelector('[data-wplg-viewport-wrap="' + namePrefix + '"]');
              var viewportSelect = document.querySelector('[data-wplg-viewport-select="' + namePrefix + '"]');

              if (!responsive || !viewportWrap || !viewportSelect) {
                return;
              }

              function sync() {
                if (responsive.checked) {
                  viewportWrap.classList.remove('is-hidden');
                  return;
                }
                viewportWrap.classList.add('is-hidden');
                viewportSelect.value = 'desktop';
              }

              responsive.addEventListener('change', function() {
                sync();
                updateDashboardSummary();
              });

              viewportSelect.addEventListener('change', updateDashboardSummary);
              sync();
            }

            (function bindDashboardViewport() {
              var responsive = document.getElementById('wplg_responsive_scan');
              var viewportWrap = document.querySelector('[data-wplg-viewport-wrap="dashboard"]');
              var viewportSelect = document.querySelector('[data-wplg-viewport-select="dashboard"]');
              if (!responsive || !viewportWrap || !viewportSelect) return;

              function sync() {
                if (responsive.checked) {
                  viewportWrap.classList.remove('is-hidden');
                  return;
                }
                viewportWrap.classList.add('is-hidden');
                viewportSelect.value = 'desktop';
              }

              responsive.addEventListener('change', function() {
                sync();
                updateDashboardSummary();
              });
              viewportSelect.addEventListener('change', updateDashboardSummary);
              sync();
            })();

            bindViewportToggle('wplg_scan_options');

            document.querySelectorAll('.wplg-scan-config-form input, .wplg-scan-config-form select').forEach(function(field) {
              field.addEventListener('change', updateDashboardSummary);
            });

            updateDashboardSummary();
          })();
        </script>
        <?php
    }

    private function api_request(string $method, string $path, ?array $body = null, bool $includeSiteToken = true)
    {
        $base = $this->get_api_base();
        if ($base === '') {
            return new WP_Error('wplg_api_base_missing', 'Set API Base URL in LaunchGuard Settings first.');
        }

        $url = $base . '/' . ltrim($path, '/');
        $headers = ['Accept' => 'application/json'];

        if ($includeSiteToken) {
            $siteToken = $this->get_option(self::OPTION_SITE_TOKEN);
            if ($siteToken !== '') {
                $headers['x-launchguard-site-token'] = $siteToken;
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
            return new WP_Error('wplg_api_error', $message);
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
        if ($status === 'completed') {
            return 100;
        }

        if (in_array($status, ['failed', 'cancelled'], true)) {
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

        return '';
    }

    private function extract_issues_total(array $summary): ?int
    {
        if (isset($summary['issues_total']) && is_numeric($summary['issues_total'])) {
            return (int) $summary['issues_total'];
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

        $class = 'wplg-status-pill status-' . sanitize_html_class($value);
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

    private function redirect_with_notice(string $page, string $status, string $message): void
    {
        $url = add_query_arg(
            [
                'page' => $page,
                'wplg_notice' => $status,
                'wplg_message' => $message
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
                'wplg_notice' => $status,
                'wplg_message' => $message,
                'wplg_scan_id' => $scanId
            ],
            admin_url('post.php')
        );

        wp_safe_redirect($url);
        exit;
    }
}

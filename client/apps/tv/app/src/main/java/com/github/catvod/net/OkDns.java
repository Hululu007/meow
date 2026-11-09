package com.github.catvod.net;

import androidx.annotation.NonNull;

import com.github.catvod.bean.Doh;
import com.github.catvod.utils.Util;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import java.util.stream.Collectors;

import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.dnsoverhttps.DnsOverHttps;

public class OkDns implements Dns {

    private final ConcurrentHashMap<String, String> map;
    private volatile Supplier<Doh> supplier;
    private volatile DnsOverHttps doh;

    public OkDns() {
        this.map = new ConcurrentHashMap<>();
    }

    public synchronized void setDoh(Doh item) {
        HttpUrl url = HttpUrl.parse(item.getUrl());
        this.doh = url == null ? null : new DnsOverHttps.Builder().client(new OkHttpClient()).url(url).bootstrapDnsHosts(item.getHosts()).build();
        this.supplier = null;
    }

    public synchronized void setDoh(Supplier<Doh> supplier) {
        this.supplier = supplier;
    }

    public void clear() {
        map.clear();
    }

    public void addAll(List<String> hosts) {
        map.putAll(hosts.stream().filter(Objects::nonNull).map(host -> host.split("=", 2)).filter(splits -> splits.length == 2).collect(Collectors.toMap(s -> s[0].trim(), s -> s[1].trim(), (oldHost, newHost) -> newHost)));
    }

    private String get(String hostname) {
        String target = map.get(hostname);
        if (target != null) return target;
        for (Map.Entry<String, String> entry : map.entrySet()) if (Util.containOrMatch(hostname, entry.getKey())) return entry.getValue();
        return hostname;
    }

    /**
     * 解析顺序：hosts 静态映射 → DoH → 系统 DNS。
     *
     * <p><b>为什么必须有 DoH 失败回退</b>：原来这里是一行
     * {@code (doh != null ? doh : Dns.SYSTEM).lookup(...)} —— 一旦设了 DoH
     * 就只用 DoH，它抛 {@code UnknownHostException} 时直接向上抛出。
     *
     * <p>实测后果（MuMu Android 15）：打开 DoH 后**11 个源全部 0.0s 返回空**，
     * 连原本正常的 AppGet/SaoHuo 也挂 —— 因为 okhttp-dnsoverhttps 在该 ROM 上
     * 的请求被 reset，而它不会退回系统 DNS，于是每一次解析都失败。
     * 关掉 DoH 后同一批源 5/11 可用。
     *
     * <p><b>为什么不直接无脑兜底</b>：系统 DNS 正是被污染的那一个，无脑退回等于
     * 把"用 DoH 绕开污染"这件事作废。所以这里做的是**有条件回退**：
     * <ul>
     *   <li>DoH 返回非空 → 用它（说明 DoH 可用，污染被绕开了）</li>
     *   <li>DoH 抛异常或返回空 → 退回系统 DNS，至少让没被污染的域名能用</li>
     * </ul>
     * 两种情况的差别是"能不能绕开污染"，而不是"能不能用"——退一步总比全挂好。
     */
    @NonNull
    @Override
    public List<InetAddress> lookup(@NonNull String hostname) throws UnknownHostException {
        Supplier<Doh> supplier = this.supplier;
        if (supplier != null) initDoh(supplier);
        String target = get(hostname);
        DnsOverHttps d = this.doh;
        if (d == null) return Dns.SYSTEM.lookup(target);
        try {
            List<InetAddress> out = d.lookup(target);
            if (out != null && !out.isEmpty()) return out;
            // 空结果也当失败：DoH 在某些网络上返回 200 但 Answer 为空
        } catch (Throwable t) {
            // DoH 不可用（reset / 超时 / 证书）→ 落系统 DNS
        }
        return Dns.SYSTEM.lookup(target);
    }

    private synchronized void initDoh(Supplier<Doh> supplier) {
        if (supplier != this.supplier) return;
        setDoh(supplier.get());
    }
}

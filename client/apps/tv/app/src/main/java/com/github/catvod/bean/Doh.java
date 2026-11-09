package com.github.catvod.bean;

import android.content.Context;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.annotations.SerializedName;
import com.google.gson.reflect.TypeToken;

import java.lang.reflect.Type;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class Doh {

    @SerializedName("name")
    private String name;
    @SerializedName("url")
    private String url;
    @SerializedName("ips")
    private List<String> ips;

    /**
     * 内置 DoH 服务商。
     *
     * <p>上游从 App 的 {@code R.array.doh_url} 读（那是 Fongmi 自己的资源表）；
     * TV 壳没有那两个数组资源，所以直接写死同一组公共 DoH。
     * 用户配置里的 {@code doh} 表仍然优先（见后端 dohProviderFromTable）。
     */
    public static List<Doh> get(Context context) {
        List<Doh> items = new ArrayList<>();
        String[] names = {"阿里", "腾讯", "360"};
        String[] urls = {
                "https://dns.alidns.com/resolve",
                "https://doh.pub/dns-query",
                "https://doh.360.cn/resolve",
        };
        /*
         * ★ 必须带 bootstrap IP。
         *
         * `DnsOverHttps` 要先连上 DoH 服务器才能查 DNS，而连它自己需要解析
         * 它的域名 —— 鸡生蛋问题。okhttp-dnsoverhttps 的解法是 `bootstrapDnsHosts`
         * （预先写死的 IP，不再查 DNS）。留空时它会退回系统 DNS 解析该域名，
         * 而系统 DNS 正是我们想绕开的那一环。
         *
         * 实测（MuMu，Android 15）：不设 ips 时 `bootstrap 0 个 IP`，
         * 随后**所有源一起 0.0s 返回空**（连原本正常的 AppGet/SaoHuo 也挂），
         * 比不开 DoH 还差。补上 IP 后才有意义。
         */
        String[][] ips = {
                {"223.5.5.5", "223.6.6.6"},           // dns.alidns.com
                {"1.12.12.12", "120.53.53.53"},       // doh.pub
                {"101.226.4.6", "218.30.118.6"},      // doh.360.cn
        };
        for (int i = 0; i < names.length; i++) {
            List<String> ipList = new ArrayList<>();
            for (String ip : ips[i]) ipList.add(ip);
            items.add(new Doh().name(names[i]).url(urls[i]).ips(ipList));
        }
        return items;
    }

    public static Doh objectFrom(String str) {
        Doh item = new Gson().fromJson(str, Doh.class);
        return item == null ? new Doh() : item;
    }

    public static List<Doh> arrayFrom(JsonElement element) {
        try {
            Type listType = TypeToken.getParameterized(List.class, Doh.class).getType();
            List<Doh> items = new Gson().fromJson(element, listType);
            return items == null ? new ArrayList<>() : items;
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    public Doh name(String name) {
        this.name = name;
        return this;
    }

    public Doh url(String url) {
        this.url = url;
        return this;
    }

    /**
     * 设 bootstrap IP（链式，与 {@link #name}/{@link #url} 同风格）。
     *
     * <p>{@code DnsOverHttps} 需要预先写死的 IP 才能连上 DoH 服务器本身
     * （否则要用系统 DNS 解析它，而系统 DNS 正是要绕开的污染源）。
     */
    public Doh ips(List<String> ips) {
        this.ips = ips;
        return this;
    }

    public String getName() {
        return TextUtils.isEmpty(name) ? "" : name;
    }

    public String getUrl() {
        return TextUtils.isEmpty(url) ? "" : url;
    }

    public List<String> getIps() {
        return ips == null ? Collections.emptyList() : ips;
    }

    public List<InetAddress> getHosts() {
        try {
            List<InetAddress> list = new ArrayList<>();
            for (String ip : getIps()) list.add(InetAddress.getByName(ip));
            return list.isEmpty() ? null : list;
        } catch (Exception ignored) {
            return null;
        }
    }

    @Override
    public boolean equals(@Nullable Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof Doh it)) return false;
        return getUrl().equals(it.getUrl());
    }

    @Override
    public int hashCode() {
        return getUrl().hashCode();
    }

    @NonNull
    @Override
    public String toString() {
        return new Gson().toJson(this);
    }
}
